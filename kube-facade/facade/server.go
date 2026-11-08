// Package facade serves a small slice of the Kubernetes API (core/v1 Pods,
// Nodes, Events, Namespaces; apps/v1 Deployments with the scale subresource) on
// top of a Sheeternetes spreadsheet, so that real kubectl and k9s can drive it.
// Every request is translated into calls to the Sheet apiserver (Apps Script or
// hack/local-apiserver.js); there is no storage of its own.
package facade

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	jsonpatch "gopkg.in/evanphx/json-patch.v4"

	"github.com/sncfoundation/sheeternetes/internal/kube"
	"github.com/sncfoundation/sheeternetes/internal/sheetapi"
	appsv1 "k8s.io/api/apps/v1"
	authzv1 "k8s.io/api/authorization/v1"
	autoscalingv1 "k8s.io/api/autoscaling/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/strategicpatch"
	"k8s.io/client-go/kubernetes/scheme"
)

// Sheet is what the facade needs from the Sheet apiserver.
type Sheet interface {
	Deployments(ctx context.Context) ([]sheetapi.Deployment, error)
	Pods(ctx context.Context) ([]sheetapi.Pod, error)
	Nodes(ctx context.Context) ([]sheetapi.Node, error)
	Events(ctx context.Context) ([]sheetapi.Event, error)
	Logs(ctx context.Context, pod string) (string, error)
	Apply(ctx context.Context, deps ...sheetapi.Deployment) error
	Scale(ctx context.Context, name string, replicas int64) error
	Delete(ctx context.Context, name string) error
	DeletePod(ctx context.Context, name string) error
	Cordon(ctx context.Context, node string, cordon bool) error
}

// Versioner hands out resourceVersions. The default counts content changes of
// the whole Sheet; a revision-history backed one can replace it.
type Versioner interface {
	// Version returns the resourceVersion for a snapshot with the given content hash.
	Version(ctx context.Context, contentHash string) (string, error)
}

// Server is the facade.
type Server struct {
	Sheet     Sheet
	Token     string        // optional bearer token clients must present
	Poll      time.Duration // how often watches re-read the Sheet
	Versioner Versioner

	mu      sync.Mutex
	history map[string]map[string]map[string]object // rv -> resource -> key -> object
	order   []string
}

// New returns a facade over one Sheet.
func New(sheet Sheet) *Server {
	return &Server{Sheet: sheet, Poll: 2 * time.Second, Versioner: &counter{}}
}

// counter: resourceVersion = number of distinct Sheet contents seen so far.
type counter struct {
	mu   sync.Mutex
	last string
	n    int
}

func (c *counter) Version(_ context.Context, h string) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if h != c.last {
		c.last, c.n = h, c.n+1
	}
	return strconv.Itoa(c.n), nil
}

type object struct {
	obj    runtime.Object
	raw    []byte
	labels labels.Set
	fields fields.Set
	ns     string
}

// snapshot reads the whole Sheet once and renders every resource.
func (s *Server) snapshot(ctx context.Context) (string, map[string]map[string]object, error) {
	deps, err := s.Sheet.Deployments(ctx)
	if err != nil {
		return "", nil, err
	}
	pods, err := s.Sheet.Pods(ctx)
	if err != nil {
		return "", nil, err
	}
	nodes, err := s.Sheet.Nodes(ctx)
	if err != nil {
		return "", nil, err
	}
	events, err := s.Sheet.Events(ctx)
	if err != nil {
		return "", nil, err
	}
	raw, _ := json.Marshal([]any{deps, pods, nodes, events})
	sum := sha256.Sum256(raw)
	rv, err := s.Versioner.Version(ctx, hex.EncodeToString(sum[:]))
	if err != nil {
		return "", nil, err
	}

	snap := map[string]map[string]object{"pods": {}, "deployments": {}, "nodes": {}, "events": {}, "namespaces": {}, "replicasets": {}}
	add := func(res string, o metav1.Object, ro runtime.Object, f fields.Set) {
		o.SetResourceVersion(rv)
		b, _ := json.Marshal(ro)
		if f == nil {
			f = fields.Set{}
		}
		f["metadata.name"], f["metadata.namespace"] = o.GetName(), o.GetNamespace()
		snap[res][o.GetNamespace()+"/"+o.GetName()] = object{obj: ro, raw: b, labels: o.GetLabels(), fields: f, ns: o.GetNamespace()}
	}
	// the Sheet keeps no creation times; the first Event about an object is one
	born := map[string]metav1.Time{}
	for _, e := range events {
		k := e.Kind + "/" + e.Object
		if _, ok := born[k]; !ok {
			born[k] = kube.ParseTime(e.TS)
		}
	}
	birth := func(o metav1.Object, kind, sheetName string) {
		cur := o.GetCreationTimestamp()
		if t, ok := born[kind+"/"+sheetName]; ok && (cur.IsZero() || t.Before(&cur)) {
			o.SetCreationTimestamp(t)
		}
	}
	namespaces := map[string]bool{"default": true}
	for _, d := range deps {
		o := kube.Deployment(d, pods)
		birth(o, "Deployment", d.Name)
		namespaces[o.Namespace] = true
		add("deployments", o, o, nil)
	}
	for _, p := range pods {
		if p.Phase == "Deleted" {
			continue
		}
		o := kube.Pod(p)
		birth(o, "Pod", p.Name)
		namespaces[o.Namespace] = true
		add("pods", o, o, fields.Set{"spec.nodeName": o.Spec.NodeName, "status.phase": string(o.Status.Phase)})
	}
	for _, n := range nodes {
		o := kube.Node(n)
		birth(o, "Node", n.Name)
		add("nodes", o, o, nil)
	}
	for i, e := range events {
		o := kube.Event(i, e)
		add("events", o, o, fields.Set{"involvedObject.kind": o.InvolvedObject.Kind, "involvedObject.name": o.InvolvedObject.Name,
			"involvedObject.namespace": o.InvolvedObject.Namespace, "involvedObject.uid": string(o.InvolvedObject.UID),
			"reason": o.Reason, "type": o.Type})
	}
	for ns := range namespaces {
		o := &corev1.Namespace{TypeMeta: metav1.TypeMeta{Kind: "Namespace", APIVersion: "v1"},
			ObjectMeta: metav1.ObjectMeta{Name: ns, UID: kube.UID("Namespace", "", ns)},
			Status:     corev1.NamespaceStatus{Phase: corev1.NamespaceActive}}
		add("namespaces", o, o, fields.Set{"status.phase": "Active"})
	}

	s.mu.Lock()
	if s.history == nil {
		s.history = map[string]map[string]map[string]object{}
	}
	if _, ok := s.history[rv]; !ok {
		s.history[rv] = snap
		s.order = append(s.order, rv)
		if len(s.order) > 64 {
			delete(s.history, s.order[0])
			s.order = s.order[1:]
		}
	}
	s.mu.Unlock()
	return rv, snap, nil
}

// ---------------------------------------------------------------- HTTP

type route struct {
	group, version string // "" / "v1" for core
	namespace      string
	resource       string
	name           string
	sub            string
}

var namespaced = map[string]bool{"pods": true, "deployments": true, "events": true, "replicasets": true}

func parse(path string) (route, bool) {
	seg := strings.Split(strings.Trim(path, "/"), "/")
	var r route
	switch {
	case len(seg) >= 2 && seg[0] == "api":
		r.version, seg = seg[1], seg[2:]
	case len(seg) >= 3 && seg[0] == "apis":
		r.group, r.version, seg = seg[1], seg[2], seg[3:]
	default:
		return r, false
	}
	if len(seg) >= 2 && seg[0] == "namespaces" && len(seg) != 2 {
		r.namespace, seg = seg[1], seg[2:]
	}
	if len(seg) == 0 {
		return r, false
	}
	r.resource = seg[0]
	if len(seg) > 1 {
		r.name = seg[1]
	}
	if len(seg) > 2 {
		r.sub = seg[2]
	}
	if len(seg) > 3 {
		return r, false
	}
	return r, true
}

// ServeHTTP implements http.Handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	if s.Token != "" && req.Header.Get("Authorization") != "Bearer "+s.Token {
		writeStatus(w, http.StatusUnauthorized, metav1.StatusReasonUnauthorized, "a bearer token is required")
		return
	}
	if d, ok := discovery(req.URL.Path); ok {
		writeJSON(w, http.StatusOK, d)
		return
	}
	r, ok := parse(req.URL.Path)
	if !ok {
		writeStatus(w, http.StatusNotFound, metav1.StatusReasonNotFound, "the server could not find the requested resource")
		return
	}
	ctx := req.Context()
	switch {
	case r.group == "authorization.k8s.io":
		s.authz(w, req, r)
	case r.group == "" && r.resource == "pods" && r.sub == "log":
		s.logs(w, req, r)
	case r.group == "apps" && r.resource == "deployments" && r.sub == "scale":
		s.scale(ctx, w, req, r)
	case r.sub != "":
		writeStatus(w, http.StatusNotFound, metav1.StatusReasonNotFound, "unknown subresource "+r.sub)
	case req.Method == http.MethodGet && r.name == "" && req.URL.Query().Get("watch") != "" && req.URL.Query().Get("watch") != "false":
		s.watch(w, req, r)
	case req.Method == http.MethodGet && r.name == "":
		s.list(ctx, w, req, r)
	case req.Method == http.MethodGet:
		s.get(ctx, w, req, r)
	case req.Method == http.MethodPost && r.resource == "deployments":
		s.createDeployment(ctx, w, req, r)
	case req.Method == http.MethodPatch || req.Method == http.MethodPut:
		s.patch(ctx, w, req, r)
	case req.Method == http.MethodDelete:
		s.delete(ctx, w, req, r)
	default:
		writeStatus(w, http.StatusMethodNotAllowed, metav1.StatusReasonMethodNotAllowed,
			fmt.Sprintf("%s %s is not supported by a spreadsheet", req.Method, r.resource))
	}
}

func resourceKnown(r route) bool {
	switch r.group + "/" + r.resource {
	case "/pods", "/nodes", "/events", "/namespaces", "apps/deployments", "apps/replicasets":
		return true
	}
	return false
}

func (s *Server) selected(req *http.Request, r route, snap map[string]map[string]object) ([]object, error) {
	ls, err := labels.Parse(req.URL.Query().Get("labelSelector"))
	if err != nil {
		return nil, err
	}
	fs, err := fields.ParseSelector(req.URL.Query().Get("fieldSelector"))
	if err != nil {
		return nil, err
	}
	var out []object
	for _, o := range snap[r.resource] {
		if namespaced[r.resource] && r.namespace != "" && o.ns != r.namespace {
			continue
		}
		if ls.Matches(o.labels) && fs.Matches(o.fields) {
			out = append(out, o)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ns+"/"+name(out[i]) < out[j].ns+"/"+name(out[j]) })
	if r.resource == "events" {
		sort.SliceStable(out, func(i, j int) bool {
			return out[i].obj.(*corev1.Event).LastTimestamp.Before(&out[j].obj.(*corev1.Event).LastTimestamp)
		})
	}
	return out, nil
}

func name(o object) string { return o.obj.(metav1.Object).GetName() }

var listKinds = map[string]string{"pods": "PodList", "deployments": "DeploymentList", "nodes": "NodeList",
	"events": "EventList", "namespaces": "NamespaceList", "replicasets": "ReplicaSetList"}

func (s *Server) list(ctx context.Context, w http.ResponseWriter, req *http.Request, r route) {
	if !resourceKnown(r) {
		writeStatus(w, http.StatusNotFound, metav1.StatusReasonNotFound, "the server could not find the requested resource")
		return
	}
	rv, snap, err := s.snapshot(ctx)
	if err != nil {
		writeStatus(w, http.StatusServiceUnavailable, metav1.StatusReasonServiceUnavailable, err.Error())
		return
	}
	objs, err := s.selected(req, r, snap)
	if err != nil {
		writeStatus(w, http.StatusBadRequest, metav1.StatusReasonBadRequest, err.Error())
		return
	}
	if wantsTable(req) {
		writeJSON(w, http.StatusOK, table(r.resource, objs, rv))
		return
	}
	items := make([]json.RawMessage, 0, len(objs))
	for _, o := range objs {
		items = append(items, o.raw)
	}
	apiVersion := "v1"
	if r.group != "" {
		apiVersion = r.group + "/" + r.version
	}
	writeJSON(w, http.StatusOK, map[string]any{"kind": listKinds[r.resource], "apiVersion": apiVersion,
		"metadata": map[string]any{"resourceVersion": rv}, "items": items})
}

func (s *Server) find(ctx context.Context, r route) (string, object, bool, error) {
	rv, snap, err := s.snapshot(ctx)
	if err != nil {
		return "", object{}, false, err
	}
	ns := r.namespace
	if !namespaced[r.resource] {
		ns = ""
	}
	o, ok := snap[r.resource][ns+"/"+r.name]
	return rv, o, ok, nil
}

func (s *Server) get(ctx context.Context, w http.ResponseWriter, req *http.Request, r route) {
	if !resourceKnown(r) {
		writeStatus(w, http.StatusNotFound, metav1.StatusReasonNotFound, "the server could not find the requested resource")
		return
	}
	rv, o, ok, err := s.find(ctx, r)
	if err != nil {
		writeStatus(w, http.StatusServiceUnavailable, metav1.StatusReasonServiceUnavailable, err.Error())
		return
	}
	if !ok {
		notFound(w, r)
		return
	}
	if wantsTable(req) {
		writeJSON(w, http.StatusOK, table(r.resource, []object{o}, rv))
		return
	}
	writeRaw(w, http.StatusOK, o.raw)
}

func notFound(w http.ResponseWriter, r route) {
	group := r.group
	st := metav1.Status{TypeMeta: metav1.TypeMeta{Kind: "Status", APIVersion: "v1"}, Status: metav1.StatusFailure,
		Reason: metav1.StatusReasonNotFound, Code: http.StatusNotFound,
		Message: fmt.Sprintf("%s %q not found", r.resource, r.name),
		Details: &metav1.StatusDetails{Name: r.name, Group: group, Kind: r.resource}}
	writeJSON(w, http.StatusNotFound, st)
}

func (s *Server) createDeployment(ctx context.Context, w http.ResponseWriter, req *http.Request, r route) {
	var d appsv1.Deployment
	if err := decode(req, &d); err != nil {
		writeStatus(w, http.StatusBadRequest, metav1.StatusReasonBadRequest, err.Error())
		return
	}
	if d.Namespace == "" {
		d.Namespace = r.namespace
	}
	if d.Namespace == "" {
		d.Namespace = "default"
	}
	row, err := kube.FromDeployment(&d)
	if err != nil {
		writeStatus(w, http.StatusUnprocessableEntity, metav1.StatusReasonInvalid, err.Error())
		return
	}
	if _, _, exists, err := s.find(ctx, route{group: "apps", resource: "deployments", namespace: d.Namespace, name: d.Name}); err == nil && exists {
		writeStatus(w, http.StatusConflict, metav1.StatusReasonAlreadyExists, fmt.Sprintf("deployments.apps %q already exists", d.Name))
		return
	}
	if req.URL.Query().Get("dryRun") == "" {
		if err := s.Sheet.Apply(ctx, row); err != nil {
			writeStatus(w, http.StatusServiceUnavailable, metav1.StatusReasonServiceUnavailable, err.Error())
			return
		}
	}
	out := kube.Deployment(row, nil)
	writeJSON(w, http.StatusCreated, out)
}

// patch handles PATCH/PUT on deployments (spec) and nodes (cordon).
func (s *Server) patch(ctx context.Context, w http.ResponseWriter, req *http.Request, r route) {
	if r.resource != "deployments" && r.resource != "nodes" {
		writeStatus(w, http.StatusMethodNotAllowed, metav1.StatusReasonMethodNotAllowed, "only deployments and nodes can be changed")
		return
	}
	_, cur, ok, err := s.find(ctx, r)
	if err != nil {
		writeStatus(w, http.StatusServiceUnavailable, metav1.StatusReasonServiceUnavailable, err.Error())
		return
	}
	if !ok {
		notFound(w, r)
		return
	}
	body, _ := io.ReadAll(io.LimitReader(req.Body, 1<<20))
	var dataStruct any = &appsv1.Deployment{}
	if r.resource == "nodes" {
		dataStruct = &corev1.Node{}
	}
	updated, err := applyPatch(req, cur.raw, body, dataStruct)
	if err != nil {
		writeStatus(w, http.StatusUnprocessableEntity, metav1.StatusReasonInvalid, err.Error())
		return
	}
	if r.resource == "nodes" {
		var n corev1.Node
		if err := json.Unmarshal(updated, &n); err != nil {
			writeStatus(w, http.StatusUnprocessableEntity, metav1.StatusReasonInvalid, err.Error())
			return
		}
		if n.Spec.Unschedulable != cur.obj.(*corev1.Node).Spec.Unschedulable {
			if err := s.Sheet.Cordon(ctx, r.name, n.Spec.Unschedulable); err != nil {
				writeStatus(w, http.StatusServiceUnavailable, metav1.StatusReasonServiceUnavailable, err.Error())
				return
			}
		}
		writeJSON(w, http.StatusOK, &n)
		return
	}
	var d appsv1.Deployment
	if err := json.Unmarshal(updated, &d); err != nil {
		writeStatus(w, http.StatusUnprocessableEntity, metav1.StatusReasonInvalid, err.Error())
		return
	}
	d.Namespace, d.Name = r.namespace, r.name
	row, err := kube.FromDeployment(&d)
	if err != nil {
		writeStatus(w, http.StatusUnprocessableEntity, metav1.StatusReasonInvalid, err.Error())
		return
	}
	if err := s.Sheet.Apply(ctx, row); err != nil {
		writeStatus(w, http.StatusServiceUnavailable, metav1.StatusReasonServiceUnavailable, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, &d)
}

func applyPatch(req *http.Request, original, body []byte, dataStruct any) ([]byte, error) {
	if req.Method == http.MethodPut {
		return body, nil
	}
	switch strings.Split(req.Header.Get("Content-Type"), ";")[0] {
	case "application/json-patch+json":
		p, err := jsonpatch.DecodePatch(body)
		if err != nil {
			return nil, err
		}
		return p.Apply(original)
	case "application/merge-patch+json":
		return jsonpatch.MergePatch(original, body)
	case "application/strategic-merge-patch+json":
		return strategicpatch.StrategicMergePatch(original, body, dataStruct)
	default:
		return nil, fmt.Errorf("unsupported patch type %q", req.Header.Get("Content-Type"))
	}
}

func (s *Server) scale(ctx context.Context, w http.ResponseWriter, req *http.Request, r route) {
	_, cur, ok, err := s.find(ctx, route{group: "apps", resource: "deployments", namespace: r.namespace, name: r.name})
	if err != nil {
		writeStatus(w, http.StatusServiceUnavailable, metav1.StatusReasonServiceUnavailable, err.Error())
		return
	}
	if !ok {
		notFound(w, route{resource: "deployments", name: r.name, group: "apps"})
		return
	}
	d := cur.obj.(*appsv1.Deployment)
	sc := &autoscalingv1.Scale{
		TypeMeta:   metav1.TypeMeta{Kind: "Scale", APIVersion: "autoscaling/v1"},
		ObjectMeta: metav1.ObjectMeta{Name: d.Name, Namespace: d.Namespace, UID: d.UID, ResourceVersion: d.ResourceVersion},
		Spec:       autoscalingv1.ScaleSpec{Replicas: *d.Spec.Replicas},
		Status:     autoscalingv1.ScaleStatus{Replicas: d.Status.Replicas, Selector: "app=" + d.Name},
	}
	switch req.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, sc)
		return
	case http.MethodPatch, http.MethodPut:
	default:
		writeStatus(w, http.StatusMethodNotAllowed, metav1.StatusReasonMethodNotAllowed, "scale supports get, patch, update")
		return
	}
	raw, _ := json.Marshal(sc)
	body, _ := io.ReadAll(io.LimitReader(req.Body, 1<<20))
	updated, err := applyPatch(req, raw, body, &autoscalingv1.Scale{})
	if err != nil {
		writeStatus(w, http.StatusUnprocessableEntity, metav1.StatusReasonInvalid, err.Error())
		return
	}
	var want autoscalingv1.Scale
	if err := json.Unmarshal(updated, &want); err != nil || want.Spec.Replicas < 0 {
		writeStatus(w, http.StatusUnprocessableEntity, metav1.StatusReasonInvalid, "spec.replicas must be a non-negative integer")
		return
	}
	if err := s.Sheet.Scale(ctx, kube.JoinName(r.namespace, r.name), int64(want.Spec.Replicas)); err != nil {
		writeStatus(w, http.StatusServiceUnavailable, metav1.StatusReasonServiceUnavailable, err.Error())
		return
	}
	sc.Spec.Replicas = want.Spec.Replicas
	writeJSON(w, http.StatusOK, sc)
}

func (s *Server) delete(ctx context.Context, w http.ResponseWriter, req *http.Request, r route) {
	if r.name == "" || (r.resource != "deployments" && r.resource != "pods") {
		writeStatus(w, http.StatusMethodNotAllowed, metav1.StatusReasonMethodNotAllowed, "only single pods and deployments can be deleted")
		return
	}
	_, cur, ok, err := s.find(ctx, r)
	if err != nil {
		writeStatus(w, http.StatusServiceUnavailable, metav1.StatusReasonServiceUnavailable, err.Error())
		return
	}
	if !ok {
		notFound(w, r)
		return
	}
	if r.resource == "pods" {
		p := cur.obj.(*corev1.Pod)
		if err := s.Sheet.DeletePod(ctx, p.Annotations["sheeternetes.io/row"]); err != nil {
			writeStatus(w, http.StatusServiceUnavailable, metav1.StatusReasonServiceUnavailable, err.Error())
			return
		}
		now := metav1.Now()
		p = p.DeepCopy()
		p.DeletionTimestamp = &now
		writeJSON(w, http.StatusOK, p)
		return
	}
	if err := s.Sheet.Delete(ctx, kube.JoinName(r.namespace, r.name)); err != nil {
		writeStatus(w, http.StatusServiceUnavailable, metav1.StatusReasonServiceUnavailable, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, metav1.Status{TypeMeta: metav1.TypeMeta{Kind: "Status", APIVersion: "v1"},
		Status: metav1.StatusSuccess, Details: &metav1.StatusDetails{Name: r.name, Group: "apps", Kind: "deployments", UID: cur.obj.(metav1.Object).GetUID()}})
}

func (s *Server) logs(w http.ResponseWriter, req *http.Request, r route) {
	ctx := req.Context()
	_, cur, ok, err := s.find(ctx, route{resource: "pods", namespace: r.namespace, name: r.name})
	if err != nil {
		writeStatus(w, http.StatusServiceUnavailable, metav1.StatusReasonServiceUnavailable, err.Error())
		return
	}
	if !ok {
		notFound(w, route{resource: "pods", name: r.name})
		return
	}
	tail, err := s.Sheet.Logs(ctx, cur.obj.(*corev1.Pod).Annotations["sheeternetes.io/row"])
	if err != nil {
		writeStatus(w, http.StatusServiceUnavailable, metav1.StatusReasonServiceUnavailable, err.Error())
		return
	}
	if n, err := strconv.Atoi(req.URL.Query().Get("tailLines")); err == nil && n >= 0 {
		lines := strings.SplitAfter(tail, "\n")
		if len(lines) > 0 && lines[len(lines)-1] == "" {
			lines = lines[:len(lines)-1]
		}
		if len(lines) > n {
			tail = strings.Join(lines[len(lines)-n:], "")
		}
	}
	w.Header().Set("Content-Type", "text/plain")
	_, _ = io.WriteString(w, tail)
}

// authz: everyone may do everything; it is a spreadsheet shared with "Anyone".
func (s *Server) authz(w http.ResponseWriter, req *http.Request, r route) {
	if req.Method != http.MethodPost {
		writeStatus(w, http.StatusMethodNotAllowed, metav1.StatusReasonMethodNotAllowed, "create only")
		return
	}
	switch r.resource {
	case "selfsubjectaccessreviews":
		var ssar authzv1.SelfSubjectAccessReview
		_ = decode(req, &ssar)
		ssar.TypeMeta = metav1.TypeMeta{Kind: "SelfSubjectAccessReview", APIVersion: "authorization.k8s.io/v1"}
		ssar.Status = authzv1.SubjectAccessReviewStatus{Allowed: true, Reason: "the spreadsheet is shared with Anyone"}
		writeJSON(w, http.StatusCreated, ssar)
	case "selfsubjectrulesreviews":
		var ssrr authzv1.SelfSubjectRulesReview
		_ = decode(req, &ssrr)
		ssrr.TypeMeta = metav1.TypeMeta{Kind: "SelfSubjectRulesReview", APIVersion: "authorization.k8s.io/v1"}
		ssrr.Status = authzv1.SubjectRulesReviewStatus{ResourceRules: []authzv1.ResourceRule{{Verbs: []string{"*"}, APIGroups: []string{"*"}, Resources: []string{"*"}}}}
		writeJSON(w, http.StatusCreated, ssrr)
	default:
		writeStatus(w, http.StatusNotFound, metav1.StatusReasonNotFound, "unknown authorization resource")
	}
}

// ---------------------------------------------------------------- watch

type watchEvent struct {
	Type   string          `json:"type"`
	Object json.RawMessage `json:"object"`
}

// watch polls the Sheet and streams the differences (there is no push channel
// out of a spreadsheet).
func (s *Server) watch(w http.ResponseWriter, req *http.Request, r route) {
	if !resourceKnown(r) {
		writeStatus(w, http.StatusNotFound, metav1.StatusReasonNotFound, "the server could not find the requested resource")
		return
	}
	ctx := req.Context()
	if t, err := strconv.Atoi(req.URL.Query().Get("timeoutSeconds")); err == nil && t > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(t)*time.Second)
		defer cancel()
	}
	flusher, _ := w.(http.Flusher)
	rv, snap, err := s.snapshot(ctx)
	if err != nil {
		writeStatus(w, http.StatusServiceUnavailable, metav1.StatusReasonServiceUnavailable, err.Error())
		return
	}
	asTable := wantsTable(req)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Transfer-Encoding", "chunked")
	w.WriteHeader(http.StatusOK)
	if flusher != nil {
		flusher.Flush() // headers now, even if nothing changes for a while
	}
	enc := json.NewEncoder(w)
	send := func(typ string, o object, rv string) bool {
		raw := o.raw
		if asTable {
			raw, _ = json.Marshal(table(r.resource, []object{o}, rv))
		}
		if err := enc.Encode(watchEvent{Type: typ, Object: raw}); err != nil {
			return false
		}
		if flusher != nil {
			flusher.Flush()
		}
		return true
	}

	current := map[string]object{}
	sel, err := s.selected(req, r, snap)
	if err != nil {
		return
	}
	for _, o := range sel {
		current[o.ns+"/"+name(o)] = o
	}
	from := req.URL.Query().Get("resourceVersion")
	initialEvents := req.URL.Query().Get("sendInitialEvents") == "true"
	baseline := map[string]object{}
	if initialEvents {
		// WatchList: everything as ADDED, then a bookmark marking the end
	} else if from != "" && from != "0" && from != rv {
		s.mu.Lock()
		old, ok := s.history[from]
		s.mu.Unlock()
		if ok {
			oldSel, _ := s.selected(req, r, old)
			for _, o := range oldSel {
				baseline[o.ns+"/"+name(o)] = o
			}
		} else {
			baseline = current // unknown (expired) version: changes from now on
		}
	} else if from == rv {
		baseline = current
	}
	emit := func(prev, next map[string]object, rv string) bool {
		keys := make([]string, 0, len(next))
		for k := range next {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			o := next[k]
			p, existed := prev[k]
			if !existed {
				if !send("ADDED", o, rv) {
					return false
				}
			} else if string(p.raw) != string(o.raw) && stripRV(p.raw) != stripRV(o.raw) {
				if !send("MODIFIED", o, rv) {
					return false
				}
			}
		}
		for k, o := range prev {
			if _, ok := next[k]; !ok {
				if !send("DELETED", o, rv) {
					return false
				}
			}
		}
		return true
	}
	if !emit(baseline, current, rv) {
		return
	}
	if initialEvents {
		kind := strings.TrimSuffix(listKinds[r.resource], "List")
		apiVersion := "v1"
		if r.group != "" {
			apiVersion = r.group + "/" + r.version
		}
		bm, _ := json.Marshal(map[string]any{"kind": kind, "apiVersion": apiVersion, "metadata": map[string]any{
			"resourceVersion": rv, "annotations": map[string]string{"k8s.io/initial-events-end": "true"}}})
		if enc.Encode(watchEvent{Type: "BOOKMARK", Object: bm}) != nil {
			return
		}
		if flusher != nil {
			flusher.Flush()
		}
	}
	ticker := time.NewTicker(s.Poll)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		nrv, nsnap, err := s.snapshot(ctx)
		if err != nil {
			continue
		}
		if nrv == rv {
			continue
		}
		next := map[string]object{}
		sel, _ := s.selected(req, r, nsnap)
		for _, o := range sel {
			next[o.ns+"/"+name(o)] = o
		}
		if !emit(current, next, nrv) {
			return
		}
		current, rv = next, nrv
	}
}

// stripRV compares objects ignoring their resourceVersion.
func stripRV(raw []byte) string {
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return string(raw)
	}
	if md, ok := m["metadata"].(map[string]any); ok {
		delete(md, "resourceVersion")
	}
	b, _ := json.Marshal(m)
	return string(b)
}

// ---------------------------------------------------------------- output

// decode reads a request body in JSON or protobuf (recent kubectl sends
// application/vnd.kubernetes.protobuf for built-in types).
func decode(req *http.Request, into runtime.Object) error {
	body, err := io.ReadAll(io.LimitReader(req.Body, 1<<20))
	if err != nil {
		return err
	}
	_, _, err = scheme.Codecs.UniversalDeserializer().Decode(body, nil, into)
	return err
}

func wantsTable(req *http.Request) bool {
	return strings.Contains(req.Header.Get("Accept"), "as=Table")
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		code, b = http.StatusInternalServerError, []byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","message":"marshal"}`)
	}
	writeRaw(w, code, b)
}

func writeRaw(w http.ResponseWriter, code int, b []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_, _ = w.Write(b)
}

func writeStatus(w http.ResponseWriter, code int, reason metav1.StatusReason, msg string) {
	writeJSON(w, code, metav1.Status{TypeMeta: metav1.TypeMeta{Kind: "Status", APIVersion: "v1"},
		Status: metav1.StatusFailure, Code: int32(code), Reason: reason, Message: msg})
}
