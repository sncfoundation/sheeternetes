package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/sncfoundation/sheeternetes/internal/sheetapi"
	"github.com/sncfoundation/sheeternetes/internal/testsheet"
	"github.com/virtual-kubelet/virtual-kubelet/node/api"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func pod(name string, containers ...corev1.Container) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Namespace: "default", Name: name, CreationTimestamp: metav1.Now()},
		Spec:       corev1.PodSpec{Containers: containers},
	}
}

func TestToDeployment(t *testing.T) {
	p := pod("web", corev1.Container{
		Name: "c", Image: "nginx:alpine",
		Command: []string{"sh", "-c"}, Args: []string{"echo 'hi there' && sleep 1d"},
		Resources: corev1.ResourceRequirements{Requests: corev1.ResourceList{
			corev1.ResourceCPU: resource.MustParse("250m"), corev1.ResourceMemory: resource.MustParse("100M")}},
	})
	d, err := ToDeployment(p)
	if err != nil {
		t.Fatal(err)
	}
	want := sheetapi.Deployment{Name: "default.web", Image: "nginx:alpine", Replicas: 1, CPUReq: 250, MemReq: 96,
		Command: `sh -c 'echo '\''hi there'\'' && sleep 1d'`}
	if d != want {
		t.Fatalf("got %+v\nwant %+v", d, want)
	}
	d, _ = ToDeployment(pod("bare", corev1.Container{Name: "c", Image: "redis"}))
	if d.CPUReq != 100 || d.MemReq != 64 || d.Command != "" {
		t.Fatalf("defaults: %+v", d)
	}
	if _, err := ToDeployment(pod("two", corev1.Container{Name: "a"}, corev1.Container{Name: "b"})); err == nil {
		t.Fatal("multi-container pods must be rejected")
	}
}

// heartbeat plays kubelet.sh: report the given pods as running (with log tails).
func heartbeat(t *testing.T, url, node string, running map[string]string) []map[string]any {
	t.Helper()
	pods := []map[string]any{}
	for name, logs := range running {
		pods = append(pods, map[string]any{"name": name, "phase": "Running", "container_id": "cid-" + name, "logs": logs})
	}
	b, _ := json.Marshal(map[string]any{"token": testsheet.Token, "node": node, "ip": "10.1.2.3",
		"cpu_total": 4000, "mem_total": 4096, "pods": pods})
	res, err := http.Post(url, "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out struct{ Pods []map[string]any }
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out.Pods
}

// End to end against hack/local-apiserver.js: the real Code.gs control plane.
func TestPodLifecycleAgainstLocalApiserver(t *testing.T) {
	url := testsheet.Start(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	sheet := sheetapi.New(url, testsheet.Token)
	p := New(sheet, "sheet")
	p.cacheTTL = 0

	heartbeat(t, url, "host-a", nil) // a kubelet.sh host joins the sheet
	if c, err := Capacity(ctx, sheet); err != nil || c.Cpu().MilliValue() != 4000 {
		t.Fatalf("capacity %v %v", c, err)
	}

	k := pod("hello", corev1.Container{Name: "hello", Image: "busybox", Command: []string{"sh", "-c", "echo hi; sleep 3600"}})
	if err := p.CreatePod(ctx, k); err != nil {
		t.Fatal(err)
	}
	deps, _ := sheet.Deployments(ctx)
	if len(deps) != 1 || deps[0].Name != "default.hello" || deps[0].Command != "sh -c 'echo hi; sleep 3600'" {
		t.Fatalf("deployments tab: %+v", deps)
	}
	st, err := p.GetPodStatus(ctx, "default", "hello")
	if err != nil || st.Phase != corev1.PodPending {
		t.Fatalf("before kubelet: %+v %v", st, err)
	}

	// next heartbeat: the sheet tells host-a to run it; the one after reports it running
	desired := heartbeat(t, url, "host-a", nil)
	if len(desired) != 1 || desired[0]["image"] != "busybox" {
		t.Fatalf("kubelet desired state: %+v", desired)
	}
	sheetPod := desired[0]["name"].(string)
	heartbeat(t, url, "host-a", map[string]string{sheetPod: "hi\nfrom the spreadsheet\n"})

	got, err := p.GetPod(ctx, "default", "hello")
	if err != nil {
		t.Fatal(err)
	}
	if got.Status.Phase != corev1.PodRunning || got.Status.PodIP != "10.1.2.3" || !got.Status.ContainerStatuses[0].Ready {
		t.Fatalf("after kubelet: %+v", got.Status)
	}
	rc, err := p.GetContainerLogs(ctx, "default", "hello", "hello", api.ContainerLogOpts{Tail: 1})
	if err != nil {
		t.Fatal(err)
	}
	logs, _ := io.ReadAll(rc)
	if string(logs) != "from the spreadsheet\n" {
		t.Fatalf("logs: %q", logs)
	}
	if pods, _ := p.GetPods(ctx); len(pods) != 1 {
		t.Fatalf("GetPods: %d", len(pods))
	}

	if err := p.DeletePod(ctx, k); err != nil {
		t.Fatal(err)
	}
	deps, _ = sheet.Deployments(ctx)
	if len(deps) != 0 {
		t.Fatalf("deployment row should be gone: %+v", deps)
	}
	rows, _ := sheet.Pods(ctx)
	if len(rows) != 1 || rows[0].Phase != "Terminating" {
		t.Fatalf("sheet pod should be Terminating: %+v", rows)
	}
	if _, err := p.GetPod(ctx, "default", "hello"); err == nil {
		t.Fatal("deleted pod must be NotFound")
	}
}

func TestUnschedulableIsReported(t *testing.T) {
	url := testsheet.Start(t)
	ctx := context.Background()
	sheet := sheetapi.New(url, testsheet.Token)
	p := New(sheet, "sheet")
	p.cacheTTL = 0
	heartbeat(t, url, "tiny", nil)
	big := pod("big", corev1.Container{Name: "c", Image: "x", Resources: corev1.ResourceRequirements{
		Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("64")}}})
	if err := p.CreatePod(ctx, big); err != nil {
		t.Fatal(err)
	}
	heartbeat(t, url, "tiny", nil)
	st, err := p.GetPodStatus(ctx, "default", "big")
	if err != nil {
		t.Fatal(err)
	}
	w := st.ContainerStatuses[0].State.Waiting
	if st.Phase != corev1.PodPending || w == nil || w.Reason != "Unschedulable" {
		t.Fatalf("want Unschedulable, got %+v", st)
	}
}
