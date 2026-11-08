package facade

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/duration"
)

func col(name, typ string, priority int32) metav1.TableColumnDefinition {
	return metav1.TableColumnDefinition{Name: name, Type: typ, Priority: priority}
}

var columns = map[string][]metav1.TableColumnDefinition{
	"pods": {col("Name", "string", 0), col("Ready", "string", 0), col("Status", "string", 0), col("Restarts", "string", 0),
		col("Age", "string", 0), col("IP", "string", 1), col("Node", "string", 1)},
	"deployments": {col("Name", "string", 0), col("Ready", "string", 0), col("Up-to-date", "integer", 0),
		col("Available", "integer", 0), col("Age", "string", 0), col("Containers", "string", 1), col("Images", "string", 1), col("Selector", "string", 1)},
	"nodes": {col("Name", "string", 0), col("Status", "string", 0), col("Roles", "string", 0), col("Age", "string", 0),
		col("Version", "string", 0), col("Internal-IP", "string", 1), col("Labels", "string", 1)},
	"events":      {col("Last Seen", "string", 0), col("Type", "string", 0), col("Reason", "string", 0), col("Object", "string", 0), col("Message", "string", 0)},
	"namespaces":  {col("Name", "string", 0), col("Status", "string", 0), col("Age", "string", 0)},
	"replicasets": {col("Name", "string", 0), col("Desired", "integer", 0), col("Current", "integer", 0), col("Ready", "integer", 0), col("Age", "string", 0)},
}

func age(t metav1.Time) string {
	if t.IsZero() {
		return "<unknown>"
	}
	return duration.HumanDuration(time.Since(t.Time))
}

func cells(o runtime.Object) []any {
	switch v := o.(type) {
	case *corev1.Pod:
		ready := 0
		for _, c := range v.Status.ContainerStatuses {
			if c.Ready {
				ready++
			}
		}
		status := string(v.Status.Phase)
		if cs := v.Status.ContainerStatuses; len(cs) == 1 && cs[0].State.Waiting != nil {
			status = cs[0].State.Waiting.Reason
		}
		if v.DeletionTimestamp != nil {
			status = "Terminating"
		}
		ip, node := v.Status.PodIP, v.Spec.NodeName
		if ip == "" {
			ip = "<none>"
		}
		if node == "" {
			node = "<none>"
		}
		return []any{v.Name, fmt.Sprintf("%d/%d", ready, len(v.Spec.Containers)), status, "0", age(v.CreationTimestamp), ip, node}
	case *appsv1.Deployment:
		var images []string
		for _, c := range v.Spec.Template.Spec.Containers {
			images = append(images, c.Image)
		}
		return []any{v.Name, fmt.Sprintf("%d/%d", v.Status.ReadyReplicas, *v.Spec.Replicas), v.Status.UpdatedReplicas,
			v.Status.AvailableReplicas, age(v.CreationTimestamp), "main", strings.Join(images, ","), "app=" + v.Name}
	case *corev1.Node:
		status := "NotReady"
		if len(v.Status.Conditions) > 0 && v.Status.Conditions[0].Status == corev1.ConditionTrue {
			status = "Ready"
		}
		if v.Spec.Unschedulable {
			status += ",SchedulingDisabled"
		}
		ip := ""
		if len(v.Status.Addresses) > 0 {
			ip = v.Status.Addresses[0].Address
		}
		keys := make([]string, 0, len(v.Labels))
		for k, val := range v.Labels {
			keys = append(keys, k+"="+val)
		}
		sort.Strings(keys)
		return []any{v.Name, status, "<none>", age(v.CreationTimestamp), v.Status.NodeInfo.KubeletVersion, ip, strings.Join(keys, ",")}
	case *corev1.Event:
		return []any{age(v.LastTimestamp), v.Type, v.Reason, strings.ToLower(v.InvolvedObject.Kind) + "/" + v.InvolvedObject.Name, v.Message}
	case *corev1.Namespace:
		return []any{v.Name, string(v.Status.Phase), "<unknown>"}
	}
	return nil
}

func table(resource string, objs []object, rv string) *metav1.Table {
	t := &metav1.Table{TypeMeta: metav1.TypeMeta{Kind: "Table", APIVersion: "meta.k8s.io/v1"},
		ListMeta: metav1.ListMeta{ResourceVersion: rv}, ColumnDefinitions: columns[resource], Rows: []metav1.TableRow{}}
	for _, o := range objs {
		m := o.obj.(metav1.Object)
		pom := metav1.PartialObjectMetadata{TypeMeta: metav1.TypeMeta{Kind: "PartialObjectMetadata", APIVersion: "meta.k8s.io/v1"},
			ObjectMeta: metav1.ObjectMeta{Name: m.GetName(), Namespace: m.GetNamespace(), UID: m.GetUID(),
				ResourceVersion: m.GetResourceVersion(), CreationTimestamp: m.GetCreationTimestamp(),
				DeletionTimestamp: m.GetDeletionTimestamp(), Labels: m.GetLabels()}}
		raw, _ := json.Marshal(pom)
		t.Rows = append(t.Rows, metav1.TableRow{Cells: cells(o.obj), Object: runtime.RawExtension{Raw: raw}})
	}
	return t
}
