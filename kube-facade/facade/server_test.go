package facade

import (
	"context"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/sncfoundation/sheeternetes/internal/sheetapi"
	"github.com/sncfoundation/sheeternetes/internal/testsheet"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

func TestParse(t *testing.T) {
	cases := map[string]route{
		"/api/v1/pods":                                           {version: "v1", resource: "pods"},
		"/api/v1/namespaces/default/pods/x/log":                  {version: "v1", namespace: "default", resource: "pods", name: "x", sub: "log"},
		"/api/v1/namespaces/default":                             {version: "v1", resource: "namespaces", name: "default"},
		"/apis/apps/v1/namespaces/ns/deployments/web/scale":      {group: "apps", version: "v1", namespace: "ns", resource: "deployments", name: "web", sub: "scale"},
		"/api/v1/nodes/node-a":                                   {version: "v1", resource: "nodes", name: "node-a"},
		"/apis/authorization.k8s.io/v1/selfsubjectaccessreviews": {group: "authorization.k8s.io", version: "v1", resource: "selfsubjectaccessreviews"},
	}
	for path, want := range cases {
		got, ok := parse(path)
		if !ok || got != want {
			t.Errorf("%s: got %+v (%v), want %+v", path, got, ok, want)
		}
	}
}

// client-go itself talks to the facade, which talks to the real Code.gs.
func TestClientGoAgainstFacade(t *testing.T) {
	url := testsheet.Start(t)
	sheet := sheetapi.New(url, testsheet.Token)
	srv := New(sheet)
	srv.Poll = 100 * time.Millisecond
	ts := httptest.NewServer(srv)
	defer ts.Close()
	cs := kubernetes.NewForConfigOrDie(&rest.Config{Host: ts.URL})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if v, err := cs.Discovery().ServerVersion(); err != nil || v.GitVersion != Version.GitVersion {
		t.Fatalf("version: %v %v", v, err)
	}
	if _, err := cs.Discovery().ServerResourcesForGroupVersion("apps/v1"); err != nil {
		t.Fatal(err)
	}

	replicas := int32(2)
	dep := &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "web"}, Spec: appsv1.DeploymentSpec{
		Replicas: &replicas,
		Template: corev1.PodTemplateSpec{Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "c", Image: "nginx:alpine",
			Command: []string{"nginx", "-g", "daemon off;"}}}}}}}
	if _, err := cs.AppsV1().Deployments("default").Create(ctx, dep, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := cs.AppsV1().Deployments("default").Create(ctx, dep, metav1.CreateOptions{}); !apierrors.IsAlreadyExists(err) {
		t.Fatalf("second create should conflict, got %v", err)
	}
	rows, _ := sheet.Deployments(ctx)
	if len(rows) != 1 || rows[0].Command != "nginx -g 'daemon off;'" || rows[0].Replicas != 2 {
		t.Fatalf("deployments tab: %+v", rows)
	}

	// a node joins, so the formula scheduler places the pods
	testsheet.Heartbeat(t, url, "node-a", nil)
	pods, err := cs.CoreV1().Pods("default").List(ctx, metav1.ListOptions{LabelSelector: "app=web"})
	if err != nil || len(pods.Items) != 2 || pods.Items[0].Spec.NodeName != "node-a" {
		t.Fatalf("pods: %+v %v", pods, err)
	}
	onNode, _ := cs.CoreV1().Pods("").List(ctx, metav1.ListOptions{FieldSelector: "spec.nodeName=node-a"})
	if len(onNode.Items) != 2 {
		t.Fatalf("fieldSelector spec.nodeName: %d", len(onNode.Items))
	}

	w, err := cs.CoreV1().Pods("default").Watch(ctx, metav1.ListOptions{ResourceVersion: pods.ResourceVersion})
	if err != nil {
		t.Fatal(err)
	}
	defer w.Stop()

	sc, err := cs.AppsV1().Deployments("default").GetScale(ctx, "web", metav1.GetOptions{})
	if err != nil || sc.Spec.Replicas != 2 {
		t.Fatalf("scale: %+v %v", sc, err)
	}
	if _, err := cs.AppsV1().Deployments("default").Patch(ctx, "web", types.MergePatchType,
		[]byte(`{"spec":{"replicas":3}}`), metav1.PatchOptions{}, "scale"); err != nil {
		t.Fatal(err)
	}
	testsheet.Heartbeat(t, url, "node-a", nil)
	select {
	case ev := <-w.ResultChan():
		if ev.Type != watch.Added {
			t.Fatalf("want ADDED for the third pod, got %s", ev.Type)
		}
	case <-ctx.Done():
		t.Fatal("watch saw nothing")
	}

	if _, err := cs.CoreV1().Nodes().Patch(ctx, "node-a", types.StrategicMergePatchType,
		[]byte(`{"spec":{"unschedulable":true}}`), metav1.PatchOptions{}); err != nil {
		t.Fatal(err)
	}
	n, _ := cs.CoreV1().Nodes().Get(ctx, "node-a", metav1.GetOptions{})
	if !n.Spec.Unschedulable {
		t.Fatal("cordon via PATCH did not reach the Nodes tab")
	}

	if err := cs.AppsV1().Deployments("default").Delete(ctx, "web", metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := cs.AppsV1().Deployments("default").Get(ctx, "web", metav1.GetOptions{}); !apierrors.IsNotFound(err) {
		t.Fatalf("want NotFound, got %v", err)
	}
}

func TestResourceVersionFollowsRevisionHistory(t *testing.T) {
	url := testsheet.Start(t)
	sheet := sheetapi.New(url, testsheet.Token)
	srv := New(sheet)
	srv.Versioner = &Revisions{Source: sheet, TTL: 0}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	cs := kubernetes.NewForConfigOrDie(&rest.Config{Host: ts.URL})
	ctx := context.Background()

	revs, err := sheet.Revisions(ctx)
	if err != nil || len(revs) == 0 {
		t.Fatalf("revisions: %v %v", revs, err)
	}
	l1, err := cs.AppsV1().Deployments("").List(ctx, metav1.ListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	want := revs[len(revs)-1].ID + "000"
	if l1.ResourceVersion != want {
		t.Fatalf("resourceVersion %s, want %s (latest revision x 1000)", l1.ResourceVersion, want)
	}
	testsheet.Heartbeat(t, url, "node-a", nil) // a write -> a new revision
	revs2, _ := sheet.Revisions(ctx)
	l2, _ := cs.AppsV1().Deployments("").List(ctx, metav1.ListOptions{})
	if len(revs2) <= len(revs) || l2.ResourceVersion != revs2[len(revs2)-1].ID+"000" {
		t.Fatalf("after a write: rv %s, revisions %+v", l2.ResourceVersion, revs2)
	}
	a, _ := strconv.Atoi(l1.ResourceVersion)
	b, _ := strconv.Atoi(l2.ResourceVersion)
	if b <= a {
		t.Fatalf("resourceVersion must grow: %d -> %d", a, b)
	}
}

type fakeRevs struct{ id string }

func (f *fakeRevs) Revisions(context.Context) ([]sheetapi.Revision, error) {
	return []sheetapi.Revision{{ID: f.id}}, nil
}

func TestRevisionsCountsEditsInsideOneRevision(t *testing.T) {
	src := &fakeRevs{id: "41"}
	r := &Revisions{Source: src, TTL: 0}
	ctx := context.Background()
	steps := []struct{ rev, hash, want string }{
		{"41", "a", "41000"}, {"41", "a", "41000"}, {"41", "b", "41001"}, {"42", "c", "42000"}, {"42", "d", "42001"},
	}
	for _, s := range steps {
		src.id = s.rev
		got, _ := r.Version(ctx, s.hash)
		if got != s.want {
			t.Fatalf("rev %s hash %s: got %s want %s", s.rev, s.hash, got, s.want)
		}
	}
}
