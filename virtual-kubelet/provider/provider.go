// Package provider is a Virtual Kubelet provider whose "node" is a whole
// Sheeternetes spreadsheet. A Kubernetes Pod scheduled onto it becomes a
// one-replica row in the Deployments tab; the Sheet's own scheduler (a formula)
// places it on a kubelet.sh host, and the status, IP and log tail are read back
// from the Pods and Logs tabs.
package provider

import (
	"context"
	"io"
	"strings"
	"sync"
	"time"

	dto "github.com/prometheus/client_model/go"
	"github.com/sncfoundation/sheeternetes/internal/sheetapi"
	"github.com/virtual-kubelet/virtual-kubelet/errdefs"
	"github.com/virtual-kubelet/virtual-kubelet/node/api"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	statsv1alpha1 "k8s.io/kubelet/pkg/apis/stats/v1alpha1"
)

const (
	// LabelKey / TaintKey: pods opt in with a nodeSelector and a toleration on this key.
	LabelKey = "sheeternetes.io/sheet"
	TaintKey = "sheeternetes.io/sheet"

	defaultCPU = 100 // millicores, same default as skctl apply
	defaultMem = 64  // MiB
)

// Sheet is the subset of the sheetapi client the provider needs (fakeable in tests).
type Sheet interface {
	Apply(ctx context.Context, deps ...sheetapi.Deployment) error
	Delete(ctx context.Context, name string) error
	Pods(ctx context.Context) ([]sheetapi.Pod, error)
	Nodes(ctx context.Context) ([]sheetapi.Node, error)
	Logs(ctx context.Context, pod string) (string, error)
}

// Provider implements nodeutil.Provider.
type Provider struct {
	sheet    Sheet
	nodeName string

	mu   sync.Mutex
	pods map[string]*corev1.Pod // namespace/name -> the pod as Kubernetes sent it

	cacheTTL  time.Duration
	cacheAt   time.Time
	cacheRows []sheetapi.Pod
}

// New returns a provider for one spreadsheet.
func New(sheet Sheet, nodeName string) *Provider {
	return &Provider{sheet: sheet, nodeName: nodeName, pods: map[string]*corev1.Pod{}, cacheTTL: 2 * time.Second}
}

// DeploymentName maps a Kubernetes pod to its Deployments row. Namespaces cannot
// contain dots, so "<namespace>.<name>" is unambiguous.
func DeploymentName(namespace, name string) string { return namespace + "." + name }

func key(namespace, name string) string { return namespace + "/" + name }

// ToDeployment converts a pod spec into a Deployments row (replicas: 1).
// Sheeternetes pods have exactly one container and run `sh -c "<command>"`.
func ToDeployment(pod *corev1.Pod) (sheetapi.Deployment, error) {
	if len(pod.Spec.Containers) != 1 {
		return sheetapi.Deployment{}, errdefs.InvalidInputf("sheeternetes pods have exactly one container, %s/%s has %d",
			pod.Namespace, pod.Name, len(pod.Spec.Containers))
	}
	c := pod.Spec.Containers[0]
	cpu, mem := int64(defaultCPU), int64(defaultMem)
	if q, ok := request(c, corev1.ResourceCPU); ok {
		cpu = q.MilliValue()
	}
	if q, ok := request(c, corev1.ResourceMemory); ok {
		mem = (q.Value() + (1<<20 - 1)) >> 20 // round up to MiB
	}
	return sheetapi.Deployment{
		Name:     DeploymentName(pod.Namespace, pod.Name),
		Image:    c.Image,
		Replicas: 1,
		CPUReq:   cpu,
		MemReq:   mem,
		Command:  shellJoin(append(append([]string{}, c.Command...), c.Args...)),
	}, nil
}

func request(c corev1.Container, r corev1.ResourceName) (resource.Quantity, bool) {
	if q, ok := c.Resources.Requests[r]; ok {
		return q, true
	}
	q, ok := c.Resources.Limits[r]
	return q, ok
}

// shellJoin quotes argv for the kubelet's `sh -c`.
func shellJoin(argv []string) string {
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

func (p *Provider) rows(ctx context.Context) ([]sheetapi.Pod, error) {
	p.mu.Lock()
	if time.Since(p.cacheAt) < p.cacheTTL {
		rows := p.cacheRows
		p.mu.Unlock()
		return rows, nil
	}
	p.mu.Unlock()
	rows, err := p.sheet.Pods(ctx)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	p.cacheRows, p.cacheAt = rows, time.Now()
	p.mu.Unlock()
	return rows, nil
}

func (p *Provider) invalidate() { p.mu.Lock(); p.cacheAt = time.Time{}; p.mu.Unlock() }

// sheetPod finds the live Pods row backing a Kubernetes pod.
func (p *Provider) sheetPod(ctx context.Context, namespace, name string) (*sheetapi.Pod, error) {
	rows, err := p.rows(ctx)
	if err != nil {
		return nil, err
	}
	dep := DeploymentName(namespace, name)
	var best *sheetapi.Pod
	for i := range rows {
		r := &rows[i]
		if r.Deployment != dep || r.Phase == "Terminating" || r.Phase == "Deleted" {
			continue
		}
		if best == nil || r.Phase == "Running" {
			best = r
		}
	}
	return best, nil
}

// CreatePod writes the pod into the Deployments tab.
func (p *Provider) CreatePod(ctx context.Context, pod *corev1.Pod) error {
	d, err := ToDeployment(pod)
	if err != nil {
		return err
	}
	if err := p.sheet.Apply(ctx, d); err != nil {
		return err
	}
	p.invalidate()
	cp := pod.DeepCopy()
	cp.Status = p.status(pod, nil)
	p.mu.Lock()
	p.pods[key(pod.Namespace, pod.Name)] = cp
	p.mu.Unlock()
	return nil
}

// UpdatePod re-applies the row; a changed image rolls the Sheet pod.
func (p *Provider) UpdatePod(ctx context.Context, pod *corev1.Pod) error {
	return p.CreatePod(ctx, pod)
}

// DeletePod removes the Deployments row; the Sheet terminates the container.
func (p *Provider) DeletePod(ctx context.Context, pod *corev1.Pod) error {
	if err := p.sheet.Delete(ctx, DeploymentName(pod.Namespace, pod.Name)); err != nil {
		return err
	}
	p.invalidate()
	p.mu.Lock()
	delete(p.pods, key(pod.Namespace, pod.Name))
	p.mu.Unlock()
	return nil
}

// GetPod returns the pod with its current status from the Sheet.
func (p *Provider) GetPod(ctx context.Context, namespace, name string) (*corev1.Pod, error) {
	p.mu.Lock()
	pod, ok := p.pods[key(namespace, name)]
	p.mu.Unlock()
	if !ok {
		return nil, errdefs.NotFoundf("pod %s/%s is not known to this sheet", namespace, name)
	}
	st, err := p.GetPodStatus(ctx, namespace, name)
	if err != nil {
		return nil, err
	}
	cp := pod.DeepCopy()
	cp.Status = *st
	return cp, nil
}

// GetPodStatus maps the Pods row onto a PodStatus.
func (p *Provider) GetPodStatus(ctx context.Context, namespace, name string) (*corev1.PodStatus, error) {
	p.mu.Lock()
	pod, ok := p.pods[key(namespace, name)]
	p.mu.Unlock()
	if !ok {
		return nil, errdefs.NotFoundf("pod %s/%s is not known to this sheet", namespace, name)
	}
	row, err := p.sheetPod(ctx, namespace, name)
	if err != nil {
		return nil, err
	}
	st := p.status(pod, row)
	return &st, nil
}

// GetPods lists the pods this node runs.
func (p *Provider) GetPods(ctx context.Context) ([]*corev1.Pod, error) {
	p.mu.Lock()
	keys := make([][2]string, 0, len(p.pods))
	for _, pod := range p.pods {
		keys = append(keys, [2]string{pod.Namespace, pod.Name})
	}
	p.mu.Unlock()
	out := make([]*corev1.Pod, 0, len(keys))
	for _, k := range keys {
		pod, err := p.GetPod(ctx, k[0], k[1])
		if err != nil {
			continue
		}
		out = append(out, pod)
	}
	return out, nil
}

// status is the pure Sheet-row -> PodStatus mapping.
func (p *Provider) status(pod *corev1.Pod, row *sheetapi.Pod) corev1.PodStatus {
	cname, image := "", ""
	if len(pod.Spec.Containers) > 0 {
		cname, image = pod.Spec.Containers[0].Name, pod.Spec.Containers[0].Image
	}
	created := pod.CreationTimestamp
	st := corev1.PodStatus{Phase: corev1.PodPending, StartTime: &created}
	cs := corev1.ContainerStatus{Name: cname, Image: image}
	reason, msg := "ContainerCreating", "waiting for the spreadsheet to schedule the pod"
	if row != nil {
		st.HostIP, st.PodIP = row.NodeIP, row.NodeIP
		if row.NodeIP != "" {
			st.HostIPs = []corev1.HostIP{{IP: row.NodeIP}}
			st.PodIPs = []corev1.PodIP{{IP: row.NodeIP}}
		}
		switch row.Phase {
		case "Running":
			started := metav1.Now()
			if t, err := time.Parse(time.RFC3339, row.StartedAt); err == nil {
				started = metav1.NewTime(t)
			}
			st.Phase = corev1.PodRunning
			cs.Ready, cs.Started = true, boolPtr(true)
			cs.ContainerID = "docker://" + row.ContainerID
			cs.ImageID = image
			cs.State.Running = &corev1.ContainerStateRunning{StartedAt: started}
			st.Conditions = conditions(corev1.ConditionTrue, created)
			st.ContainerStatuses = []corev1.ContainerStatus{cs}
			return st
		case "Scheduled":
			msg = "scheduled on sheet node " + row.Node + ", waiting for its kubelet"
		case "Pending":
			if row.Message != "" {
				reason, msg = "Unschedulable", row.Message
			}
		}
	}
	cs.Started = boolPtr(false)
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

func boolPtr(b bool) *bool { return &b }

// GetContainerLogs returns the tail the kubelet shipped into the Logs tab.
func (p *Provider) GetContainerLogs(ctx context.Context, namespace, podName, containerName string, opts api.ContainerLogOpts) (io.ReadCloser, error) {
	row, err := p.sheetPod(ctx, namespace, podName)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, errdefs.NotFoundf("pod %s/%s has no container in the sheet yet", namespace, podName)
	}
	tail, err := p.sheet.Logs(ctx, row.Name)
	if err != nil {
		return nil, err
	}
	if opts.Tail > 0 {
		lines := strings.SplitAfter(tail, "\n")
		if len(lines) > 0 && lines[len(lines)-1] == "" {
			lines = lines[:len(lines)-1]
		}
		if len(lines) > opts.Tail {
			tail = strings.Join(lines[len(lines)-opts.Tail:], "")
		}
	}
	return io.NopCloser(strings.NewReader(tail)), nil
}

// RunInContainer: a spreadsheet cannot exec into your container. Yet.
func (p *Provider) RunInContainer(ctx context.Context, namespace, podName, containerName string, cmd []string, attach api.AttachIO) error {
	return errdefs.InvalidInput("exec is not supported by Sheeternetes")
}

// AttachToContainer is not supported either.
func (p *Provider) AttachToContainer(ctx context.Context, namespace, podName, containerName string, attach api.AttachIO) error {
	return errdefs.InvalidInput("attach is not supported by Sheeternetes")
}

// PortForward is not supported.
func (p *Provider) PortForward(ctx context.Context, namespace, pod string, port int32, stream io.ReadWriteCloser) error {
	return errdefs.InvalidInput("port-forward is not supported by Sheeternetes")
}

// GetStatsSummary reports the node's requested CPU/memory as usage.
func (p *Provider) GetStatsSummary(ctx context.Context) (*statsv1alpha1.Summary, error) {
	nodes, err := p.sheet.Nodes(ctx)
	if err != nil {
		return nil, err
	}
	var cpu, mem uint64
	for _, n := range nodes {
		cpu += uint64(n.CPUUsed) * 1_000_000 // millicores -> nanocores
		mem += uint64(n.MemUsed) << 20
	}
	now := metav1.Now()
	return &statsv1alpha1.Summary{Node: statsv1alpha1.NodeStats{
		NodeName:  p.nodeName,
		StartTime: now,
		CPU:       &statsv1alpha1.CPUStats{Time: now, UsageNanoCores: &cpu},
		Memory:    &statsv1alpha1.MemoryStats{Time: now, WorkingSetBytes: &mem},
	}}, nil
}

// GetMetricsResource returns no Prometheus metrics.
func (p *Provider) GetMetricsResource(ctx context.Context) ([]*dto.MetricFamily, error) {
	return nil, nil
}

// Capacity sums the Ready nodes of the sheet (falls back to a token amount).
func Capacity(ctx context.Context, sheet Sheet) (corev1.ResourceList, error) {
	nodes, err := sheet.Nodes(ctx)
	if err != nil {
		return nil, err
	}
	var cpu, mem int64
	for _, n := range nodes {
		if n.Status == "Ready" {
			cpu += n.CPUTotal
			mem += n.MemTotal
		}
	}
	if cpu == 0 {
		cpu, mem = 1000, 1024
	}
	return corev1.ResourceList{
		corev1.ResourceCPU:    *resource.NewMilliQuantity(cpu, resource.DecimalSI),
		corev1.ResourceMemory: *resource.NewQuantity(mem<<20, resource.BinarySI),
		corev1.ResourcePods:   resource.MustParse("110"),
	}, nil
}

// ConfigureNode turns the virtual node spec into "a spreadsheet".
func ConfigureNode(n *corev1.Node, capacity corev1.ResourceList, internalIP string, port int32) {
	if n.Labels == nil {
		n.Labels = map[string]string{}
	}
	n.Labels[LabelKey] = "true"
	n.Labels["kubernetes.io/os"] = "linux"
	n.Labels["node.kubernetes.io/instance-type"] = "google-sheet"
	n.Spec.Taints = append(n.Spec.Taints, corev1.Taint{Key: TaintKey, Value: "true", Effect: corev1.TaintEffectNoSchedule})
	n.Status.Capacity = capacity
	n.Status.Allocatable = capacity
	n.Status.NodeInfo = corev1.NodeSystemInfo{
		OperatingSystem: "linux", Architecture: "amd64",
		KubeletVersion:          "v0.0.0.0.0.4-sheeternetes",
		ContainerRuntimeVersion: "google-sheets://formula",
		OSImage:                 "Google Sheets",
		KernelVersion:           "Apps Script",
	}
	if internalIP != "" {
		n.Status.Addresses = []corev1.NodeAddress{{Type: corev1.NodeInternalIP, Address: internalIP}}
	}
	n.Status.DaemonEndpoints = corev1.NodeDaemonEndpoints{KubeletEndpoint: corev1.DaemonEndpoint{Port: port}}
}
