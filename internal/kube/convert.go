// Package kube converts Sheet rows (internal/sheetapi) into Kubernetes API
// objects and back. It is shared by the Virtual Kubelet provider and the
// Kubernetes API facade, so a pod looks the same through both.
package kube

import (
	"crypto/sha1"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/sncfoundation/sheeternetes/internal/sheetapi"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

// ContainerName is the name of the single container of every Sheet pod.
const ContainerName = "main"

var dnsLabel = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)

// SplitName maps a Sheet name to (namespace, name). Rows written by the Virtual
// Kubelet are "<namespace>.<name>" (namespaces cannot contain dots); everything
// else lives in "default".
func SplitName(sheetName string) (string, string) {
	if i := strings.IndexByte(sheetName, '.'); i > 0 && i < len(sheetName)-1 && dnsLabel.MatchString(sheetName[:i]) {
		return sheetName[:i], sheetName[i+1:]
	}
	return "default", sheetName
}

// JoinName is the inverse of SplitName for objects created through the facade.
func JoinName(namespace, name string) string {
	if namespace == "" || namespace == "default" {
		return name
	}
	return namespace + "." + name
}

// UID is a stable fake UID for an object (the Sheet has none).
func UID(kind, namespace, name string) types.UID {
	h := sha1.Sum([]byte(kind + "/" + namespace + "/" + name))
	return types.UID(fmt.Sprintf("%x-%x-%x-%x-%x", h[0:4], h[4:6], h[6:8], h[8:10], h[10:16]))
}

// ParseTime reads an ISO timestamp from a cell (zero time if empty/garbage).
func ParseTime(s string) metav1.Time {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		if t, err := time.Parse(layout, s); err == nil {
			return metav1.NewTime(t)
		}
	}
	return metav1.Time{}
}

// ParseKV reads "k=v,k2=v2" (labels, node selectors).
func ParseKV(s string) map[string]string {
	out := map[string]string{}
	for _, part := range strings.Split(s, ",") {
		if k, v, ok := strings.Cut(strings.TrimSpace(part), "="); ok && k != "" {
			out[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	return out
}

// FormatKV writes a map as "k=v,k2=v2" in key order.
func FormatKV(m map[string]string) string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+"="+m[k])
	}
	return strings.Join(parts, ",")
}

// ParseTaints reads "k=v:Effect,k2=v2" (no effect means NoSchedule).
func ParseTaints(s string) []corev1.Taint {
	var out []corev1.Taint
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		kv, eff, _ := strings.Cut(part, ":")
		if eff == "" {
			eff = string(corev1.TaintEffectNoSchedule)
		}
		k, v, _ := strings.Cut(kv, "=")
		out = append(out, corev1.Taint{Key: k, Value: v, Effect: corev1.TaintEffect(eff)})
	}
	return out
}

// FormatTolerations turns Kubernetes tolerations into the Sheet's "k=v,k" cell.
func FormatTolerations(tols []corev1.Toleration) string {
	var parts []string
	for _, t := range tols {
		if t.Key == "" {
			continue
		}
		if t.Operator == corev1.TolerationOpExists || t.Value == "" {
			parts = append(parts, t.Key)
		} else {
			parts = append(parts, t.Key+"="+t.Value)
		}
	}
	return strings.Join(parts, ",")
}

// Command turns a shell command cell into a container command.
func Command(cmd string) []string {
	if strings.TrimSpace(cmd) == "" {
		return nil
	}
	return []string{"sh", "-c", cmd}
}

// ShellJoin quotes argv for the kubelet's `sh -c`.
func ShellJoin(argv []string) string {
	out := make([]string, 0, len(argv))
	for _, a := range argv {
		if a != "" && strings.IndexFunc(a, func(r rune) bool {
			return !(r == '-' || r == '_' || r == '.' || r == '/' || r == '=' || r == ':' || r == ',' ||
				r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9')
		}) < 0 {
			out = append(out, a)
			continue
		}
		out = append(out, "'"+strings.ReplaceAll(a, "'", `'\''`)+"'")
	}
	return strings.Join(out, " ")
}

// ContainerCommand is the inverse of Command: `sh -c X` comes back as X.
func ContainerCommand(c corev1.Container) string {
	argv := append(append([]string{}, c.Command...), c.Args...)
	if len(argv) == 3 && argv[0] == "sh" && argv[1] == "-c" {
		return argv[2]
	}
	return ShellJoin(argv)
}

// Requests is the Sheet's (millicores, MiB) as a ResourceList.
func Requests(cpu, mem int64) corev1.ResourceList {
	return corev1.ResourceList{
		corev1.ResourceCPU:    *resource.NewMilliQuantity(cpu, resource.DecimalSI),
		corev1.ResourceMemory: *resource.NewQuantity(mem<<20, resource.BinarySI),
	}
}

// RequestsOf reads a container's requests (limits as fallback) as (millicores, MiB).
func RequestsOf(c corev1.Container, defCPU, defMem int64) (int64, int64) {
	get := func(r corev1.ResourceName) (resource.Quantity, bool) {
		if q, ok := c.Resources.Requests[r]; ok {
			return q, true
		}
		q, ok := c.Resources.Limits[r]
		return q, ok
	}
	cpu, mem := defCPU, defMem
	if q, ok := get(corev1.ResourceCPU); ok {
		cpu = q.MilliValue()
	}
	if q, ok := get(corev1.ResourceMemory); ok {
		mem = (q.Value() + (1<<20 - 1)) >> 20
	}
	return cpu, mem
}

// PodStatus maps a Pods row (nil: not in the Sheet yet) onto a PodStatus.
func PodStatus(row *sheetapi.Pod, container, image string, created metav1.Time) corev1.PodStatus {
	st := corev1.PodStatus{Phase: corev1.PodPending}
	if !created.IsZero() {
		st.StartTime = &created
	}
	cs := corev1.ContainerStatus{Name: container, Image: image}
	reason, msg := "ContainerCreating", "waiting for the spreadsheet to schedule the pod"
	if row != nil {
		st.HostIP, st.PodIP = row.NodeIP, row.NodeIP
		if row.NodeIP != "" {
			st.HostIPs = []corev1.HostIP{{IP: row.NodeIP}}
			st.PodIPs = []corev1.PodIP{{IP: row.NodeIP}}
		}
		switch row.Phase {
		case "Running", "Terminating":
			if row.Phase == "Running" || row.ContainerID != "" {
				started := ParseTime(row.StartedAt)
				if started.IsZero() {
					started = metav1.Now()
				}
				st.Phase = corev1.PodRunning
				ready := row.Phase == "Running"
				cs.Ready, cs.Started = ready, &ready
				cs.ContainerID = "docker://" + row.ContainerID
				cs.ImageID = image
				cs.State.Running = &corev1.ContainerStateRunning{StartedAt: started}
				cond := corev1.ConditionTrue
				if !ready {
					cond = corev1.ConditionFalse
				}
				st.Conditions = conditions(cond, created)
				st.ContainerStatuses = []corev1.ContainerStatus{cs}
				return st
			}
		case "Scheduled":
			msg = "scheduled on sheet node " + row.Node + ", waiting for its kubelet"
		case "Pending":
			if row.Message != "" {
				reason, msg = "Unschedulable", row.Message
			}
		}
	}
	f := false
	cs.Started = &f
	cs.State.Waiting = &corev1.ContainerStateWaiting{Reason: reason, Message: msg}
	st.Conditions = conditions(corev1.ConditionFalse, created)
	st.ContainerStatuses = []corev1.ContainerStatus{cs}
	return st
}

func conditions(ready corev1.ConditionStatus, t metav1.Time) []corev1.PodCondition {
	return []corev1.PodCondition{
		{Type: corev1.PodScheduled, Status: corev1.ConditionTrue, LastTransitionTime: t},
		{Type: corev1.PodInitialized, Status: corev1.ConditionTrue, LastTransitionTime: t},
		{Type: corev1.ContainersReady, Status: ready, LastTransitionTime: t},
		{Type: corev1.PodReady, Status: ready, LastTransitionTime: t},
	}
}

// Pod builds a full Pod from a Pods row.
func Pod(row sheetapi.Pod) *corev1.Pod {
	ns, depName := SplitName(row.Deployment)
	_, name := SplitName(row.Name)
	created := ParseTime(row.StartedAt)
	p := &corev1.Pod{
		TypeMeta: metav1.TypeMeta{Kind: "Pod", APIVersion: "v1"},
		ObjectMeta: metav1.ObjectMeta{
			Name: name, Namespace: ns, UID: UID("Pod", ns, name),
			CreationTimestamp: created,
			Labels:            map[string]string{"app": depName, "sheeternetes.io/deployment": row.Deployment},
			Annotations:       map[string]string{"sheeternetes.io/row": row.Name},
		},
		Spec: corev1.PodSpec{
			NodeName:     row.Node,
			NodeSelector: nilIfEmpty(ParseKV(row.NodeSelector)),
			Containers: []corev1.Container{{
				Name: ContainerName, Image: row.Image, Command: Command(row.Command),
				Resources: corev1.ResourceRequirements{Requests: Requests(row.CPUReq, row.MemReq)},
			}},
			RestartPolicy: corev1.RestartPolicyAlways,
		},
	}
	for _, t := range strings.Split(row.Tolerations, ",") {
		if t = strings.TrimSpace(t); t == "" {
			continue
		}
		k, v, hasV := strings.Cut(t, "=")
		tol := corev1.Toleration{Key: k, Operator: corev1.TolerationOpExists, Effect: corev1.TaintEffectNoSchedule}
		if hasV {
			tol.Operator, tol.Value = corev1.TolerationOpEqual, v
		}
		p.Spec.Tolerations = append(p.Spec.Tolerations, tol)
	}
	if row.Phase == "Terminating" {
		now := metav1.Now()
		p.DeletionTimestamp = &now
	}
	p.Status = PodStatus(&row, ContainerName, row.Image, created)
	if row.Node == "" { // in the Sheet, "not placed yet" really means not scheduled
		p.Status.Conditions[0].Status, p.Status.Conditions[0].Reason = corev1.ConditionFalse, "Unschedulable"
		p.Status.Conditions[0].Message = row.Message
	}
	return p
}

func nilIfEmpty(m map[string]string) map[string]string {
	if len(m) == 0 {
		return nil
	}
	return m
}

// Deployment builds an apps/v1 Deployment from a Deployments row and its pods.
func Deployment(d sheetapi.Deployment, pods []sheetapi.Pod) *appsv1.Deployment {
	ns, name := SplitName(d.Name)
	replicas := int32(d.Replicas)
	var live, ready, updated int32
	var created metav1.Time
	for _, p := range pods {
		if p.Deployment != d.Name || p.Phase == "Terminating" || p.Phase == "Deleted" {
			continue
		}
		live++
		if p.Phase == "Running" {
			ready++
		}
		if p.Image == d.Image && p.Command == d.Command {
			updated++
		}
		if t := ParseTime(p.StartedAt); !t.IsZero() && (created.IsZero() || t.Before(&created)) {
			created = t
		}
	}
	labels := map[string]string{"app": name}
	dep := &appsv1.Deployment{
		TypeMeta: metav1.TypeMeta{Kind: "Deployment", APIVersion: "apps/v1"},
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns, UID: UID("Deployment", ns, name),
			CreationTimestamp: created, Generation: 1, Labels: labels},
		Spec: appsv1.DeploymentSpec{
			Replicas: &replicas,
			Selector: &metav1.LabelSelector{MatchLabels: labels},
			Strategy: appsv1.DeploymentStrategy{Type: appsv1.RollingUpdateDeploymentStrategyType},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labels},
				Spec: corev1.PodSpec{
					NodeSelector: nilIfEmpty(ParseKV(d.NodeSelector)),
					Containers: []corev1.Container{{
						Name: ContainerName, Image: d.Image, Command: Command(d.Command),
						Resources: corev1.ResourceRequirements{Requests: Requests(d.CPUReq, d.MemReq)},
					}},
				},
			},
		},
		Status: appsv1.DeploymentStatus{
			ObservedGeneration: 1, Replicas: live, ReadyReplicas: ready, AvailableReplicas: ready,
			UpdatedReplicas: updated, UnavailableReplicas: max(0, replicas-ready),
		},
	}
	cond := corev1.ConditionFalse
	if ready >= replicas {
		cond = corev1.ConditionTrue
	}
	dep.Status.Conditions = []appsv1.DeploymentCondition{{Type: appsv1.DeploymentAvailable, Status: cond,
		Reason: "MinimumReplicasAvailable", Message: fmt.Sprintf("%d/%d replicas Running in the spreadsheet", ready, replicas)}}
	return dep
}

// FromDeployment turns an apps/v1 Deployment into a Deployments row.
func FromDeployment(d *appsv1.Deployment) (sheetapi.Deployment, error) {
	cs := d.Spec.Template.Spec.Containers
	if len(cs) != 1 {
		return sheetapi.Deployment{}, fmt.Errorf("sheeternetes pods have exactly one container, got %d", len(cs))
	}
	cpu, mem := RequestsOf(cs[0], 100, 64)
	replicas := int64(1)
	if d.Spec.Replicas != nil {
		replicas = int64(*d.Spec.Replicas)
	}
	return sheetapi.Deployment{
		Name: JoinName(d.Namespace, d.Name), Image: cs[0].Image, Replicas: replicas,
		CPUReq: cpu, MemReq: mem, Command: ContainerCommand(cs[0]),
		NodeSelector: FormatKV(d.Spec.Template.Spec.NodeSelector),
		Tolerations:  FormatTolerations(d.Spec.Template.Spec.Tolerations),
	}, nil
}

// Node builds a Node from a Nodes row.
func Node(n sheetapi.Node) *corev1.Node {
	hb := ParseTime(n.LastHeartbeat)
	ready := corev1.ConditionFalse
	reason := "NodeStatusUnknown"
	if n.Status == "Ready" {
		ready, reason = corev1.ConditionTrue, "KubeletReady"
	}
	labels := ParseKV(n.Labels)
	labels["kubernetes.io/hostname"] = n.Name
	labels["kubernetes.io/os"] = "linux"
	capacity := corev1.ResourceList{
		corev1.ResourceCPU:    *resource.NewMilliQuantity(n.CPUTotal, resource.DecimalSI),
		corev1.ResourceMemory: *resource.NewQuantity(n.MemTotal<<20, resource.BinarySI),
		corev1.ResourcePods:   resource.MustParse("110"),
	}
	return &corev1.Node{
		TypeMeta:   metav1.TypeMeta{Kind: "Node", APIVersion: "v1"},
		ObjectMeta: metav1.ObjectMeta{Name: n.Name, UID: UID("Node", "", n.Name), Labels: labels},
		Spec:       corev1.NodeSpec{Unschedulable: !n.Schedulable, Taints: ParseTaints(n.Taints)},
		Status: corev1.NodeStatus{
			Capacity: capacity, Allocatable: capacity,
			Conditions: []corev1.NodeCondition{{Type: corev1.NodeReady, Status: ready, Reason: reason,
				LastHeartbeatTime: hb, LastTransitionTime: hb,
				Message: fmt.Sprintf("kubelet.sh heartbeat %s; %dm/%dMi requested", n.LastHeartbeat, n.CPUUsed, n.MemUsed)}},
			Addresses: []corev1.NodeAddress{{Type: corev1.NodeInternalIP, Address: n.IP}, {Type: corev1.NodeHostName, Address: n.Name}},
			NodeInfo: corev1.NodeSystemInfo{KubeletVersion: "kubelet.sh", ContainerRuntimeVersion: "docker://",
				OperatingSystem: "linux", OSImage: "a host with bash, curl, jq and docker", KernelVersion: "?"},
		},
	}
}

// Event builds a core/v1 Event from an Events row (i = row index).
func Event(i int, e sheetapi.Event) *corev1.Event {
	ts := ParseTime(e.TS)
	ns, name := "default", e.Object
	kind := e.Kind
	if kind == "Pod" || kind == "Deployment" {
		ns, name = SplitName(e.Object)
	}
	involved := corev1.ObjectReference{Kind: kind, Name: name, Namespace: ns, UID: UID(kind, ns, name)}
	if kind == "Node" || kind == "System" {
		involved.UID = UID(kind, "", name)
		involved.Namespace = "" // cluster-scoped; the Event itself lives in "default"
	}
	reason := "Sheet"
	if f := strings.Fields(e.Message); len(f) > 0 {
		reason = strings.Trim(f[0], "(),:")
		if reason != "" {
			reason = strings.ToUpper(reason[:1]) + reason[1:]
		}
	}
	return &corev1.Event{
		TypeMeta:       metav1.TypeMeta{Kind: "Event", APIVersion: "v1"},
		ObjectMeta:     metav1.ObjectMeta{Name: name + "." + strconv.Itoa(i), Namespace: eventNamespace(involved.Namespace), UID: UID("Event", "", strconv.Itoa(i)+e.TS), CreationTimestamp: ts},
		InvolvedObject: involved, Reason: reason, Message: e.Message, Type: corev1.EventTypeNormal,
		Source:         corev1.EventSource{Component: "sheeternetes-apps-script"},
		FirstTimestamp: ts, LastTimestamp: ts, Count: 1,
	}
}

func eventNamespace(ns string) string {
	if ns == "" {
		return "default"
	}
	return ns
}
