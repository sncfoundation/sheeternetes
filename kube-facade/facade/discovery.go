package facade

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/version"
)

// Version is what `kubectl version` reports for the server.
var Version = version.Info{Major: "1", Minor: "35", GitVersion: "v1.35.0+sheeternetes.0.0.0.0.0.4",
	GitCommit: "A1", GitTreeState: "clean", BuildDate: "2026-11-08T00:00:00Z", GoVersion: "Apps Script",
	Compiler: "formula", Platform: "google/sheets"}

func res(name, kind string, namespaced bool, short []string, verbs ...string) metav1.APIResource {
	r := metav1.APIResource{Name: name, SingularName: "", Namespaced: namespaced, Kind: kind, Verbs: verbs, ShortNames: short}
	if len(name) > 1 && name[len(name)-1] == 's' {
		r.SingularName = name[:len(name)-1]
	}
	return r
}

var coreV1 = metav1.APIResourceList{
	TypeMeta:     metav1.TypeMeta{Kind: "APIResourceList", APIVersion: "v1"},
	GroupVersion: "v1",
	APIResources: []metav1.APIResource{
		withCategories(res("pods", "Pod", true, []string{"po"}, "get", "list", "watch", "delete"), "all"),
		{Name: "pods/log", Namespaced: true, Kind: "Pod", Verbs: []string{"get"}},
		res("nodes", "Node", false, []string{"no"}, "get", "list", "watch", "patch", "update"),
		res("events", "Event", true, []string{"ev"}, "get", "list", "watch"),
		res("namespaces", "Namespace", false, []string{"ns"}, "get", "list", "watch"),
	},
}

var appsV1 = metav1.APIResourceList{
	TypeMeta:     metav1.TypeMeta{Kind: "APIResourceList", APIVersion: "v1"},
	GroupVersion: "apps/v1",
	APIResources: []metav1.APIResource{
		withCategories(res("deployments", "Deployment", true, []string{"deploy"}, "create", "get", "list", "watch", "patch", "update", "delete"), "all"),
		{Name: "deployments/scale", Namespaced: true, Group: "autoscaling", Version: "v1", Kind: "Scale", Verbs: []string{"get", "patch", "update"}},
		withCategories(res("replicasets", "ReplicaSet", true, []string{"rs"}, "get", "list", "watch"), "all"),
	},
}

var authzV1 = metav1.APIResourceList{
	TypeMeta:     metav1.TypeMeta{Kind: "APIResourceList", APIVersion: "v1"},
	GroupVersion: "authorization.k8s.io/v1",
	APIResources: []metav1.APIResource{
		{Name: "selfsubjectaccessreviews", Kind: "SelfSubjectAccessReview", Verbs: []string{"create"}},
		{Name: "selfsubjectrulesreviews", Kind: "SelfSubjectRulesReview", Verbs: []string{"create"}},
	},
}

func withCategories(r metav1.APIResource, c ...string) metav1.APIResource { r.Categories = c; return r }

func group(name string) metav1.APIGroup {
	gv := metav1.GroupVersionForDiscovery{GroupVersion: name + "/v1", Version: "v1"}
	return metav1.APIGroup{TypeMeta: metav1.TypeMeta{Kind: "APIGroup", APIVersion: "v1"}, Name: name,
		Versions: []metav1.GroupVersionForDiscovery{gv}, PreferredVersion: gv}
}

// discovery answers the static documents kubectl reads before anything else.
func discovery(path string) (any, bool) {
	switch path {
	case "/version", "/version/":
		return Version, true
	case "/api", "/api/":
		return metav1.APIVersions{TypeMeta: metav1.TypeMeta{Kind: "APIVersions"}, Versions: []string{"v1"},
			ServerAddressByClientCIDRs: []metav1.ServerAddressByClientCIDR{{ClientCIDR: "0.0.0.0/0", ServerAddress: "a1"}}}, true
	case "/api/v1", "/api/v1/":
		return coreV1, true
	case "/apis", "/apis/":
		return metav1.APIGroupList{TypeMeta: metav1.TypeMeta{Kind: "APIGroupList", APIVersion: "v1"},
			Groups: []metav1.APIGroup{group("apps"), group("authorization.k8s.io")}}, true
	case "/apis/apps", "/apis/apps/":
		return group("apps"), true
	case "/apis/apps/v1", "/apis/apps/v1/":
		return appsV1, true
	case "/apis/authorization.k8s.io", "/apis/authorization.k8s.io/":
		return group("authorization.k8s.io"), true
	case "/apis/authorization.k8s.io/v1", "/apis/authorization.k8s.io/v1/":
		return authzV1, true
	case "/openapi/v2":
		return map[string]any{"swagger": "2.0", "info": map[string]any{"title": "Sheeternetes", "version": Version.GitVersion},
			"paths": map[string]any{}, "definitions": map[string]any{}}, true
	case "/openapi/v3":
		return map[string]any{"paths": map[string]any{}}, true
	case "/healthz", "/readyz", "/livez":
		return "ok", true
	}
	return nil, false
}
