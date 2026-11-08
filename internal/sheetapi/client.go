// Package sheetapi is a Go client for the Sheeternetes apiserver: the Apps Script
// Web App (Code.gs) in front of a Google Sheet, or hack/local-apiserver.js which
// runs the same Code.gs in Node. It is shared by the Virtual Kubelet provider and
// the Kubernetes API facade.
package sheetapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Client talks to one Sheeternetes control plane (one spreadsheet).
type Client struct {
	URL   string // the Web App /exec URL
	Token string
	HTTP  *http.Client
}

// New returns a client with a sane timeout. Apps Script is slow; be patient.
func New(url, token string) *Client {
	return &Client{URL: url, Token: token, HTTP: &http.Client{Timeout: 60 * time.Second}}
}

// Deployment is one row of the Deployments tab.
type Deployment struct {
	Name         string `json:"name"`
	Image        string `json:"image"`
	Replicas     int64  `json:"replicas"`
	CPUReq       int64  `json:"cpu_req"` // millicores
	MemReq       int64  `json:"mem_req"` // MiB
	Command      string `json:"command"`
	NodeSelector string `json:"node_selector,omitempty"`
	Tolerations  string `json:"tolerations,omitempty"`
}

// Pod is one row of the Pods tab.
type Pod struct {
	Name         string
	Deployment   string
	Node         string
	Phase        string // Pending, Scheduled, Running, Terminating, Deleted
	ContainerID  string
	Image        string
	CPUReq       int64
	MemReq       int64
	Command      string
	NodeIP       string
	StartedAt    string
	Message      string
	NodeSelector string
	Tolerations  string
}

// Node is one row of the Nodes tab.
type Node struct {
	Name          string
	IP            string
	CPUTotal      int64
	MemTotal      int64
	CPUUsed       int64
	MemUsed       int64
	Status        string
	LastHeartbeat string
	Schedulable   bool
	Labels        string
	Taints        string
}

// Event is one row of the Events tab.
type Event struct {
	TS      string
	Kind    string
	Object  string
	Message string
}

// Log is one row of the Logs tab: the tail a kubelet shipped for a pod.
type Log struct {
	Name      string
	Node      string
	UpdatedAt string
	Tail      string
}

type row map[string]any

func (r row) str(k string) string {
	switch v := r[k].(type) {
	case nil:
		return ""
	case string:
		return v
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(v)
	default:
		return fmt.Sprint(v)
	}
}

func (r row) num(k string) int64 {
	switch v := r[k].(type) {
	case float64:
		return int64(v)
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		if err != nil {
			return 0
		}
		return int64(f)
	default:
		return 0
	}
}

// schedulable: blank means yes; FALSE / 0 / NO (any case) means cordoned.
func (r row) schedulable() bool {
	switch strings.ToUpper(strings.TrimSpace(r.str("schedulable"))) {
	case "FALSE", "0", "NO":
		return false
	}
	return true
}

func (c *Client) get(ctx context.Context, kind string, extra url.Values) ([]row, error) {
	q := url.Values{"token": {c.Token}, "kind": {kind}}
	for k, v := range extra {
		q[k] = v
	}
	sep := "?"
	if strings.Contains(c.URL, "?") {
		sep = "&"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.URL+sep+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	var out struct {
		Items []row  `json:"items"`
		Error string `json:"error"`
	}
	if err := c.do(req, &out); err != nil {
		return nil, err
	}
	if out.Error != "" {
		return nil, fmt.Errorf("sheet apiserver: %s", out.Error)
	}
	return out.Items, nil
}

func (c *Client) post(ctx context.Context, body map[string]any, out any) error {
	body["token"] = c.Token
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.URL, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	var res struct {
		Error string `json:"error"`
	}
	raw := json.RawMessage{}
	if err := c.do(req, &raw); err != nil {
		return err
	}
	if err := json.Unmarshal(raw, &res); err == nil && res.Error != "" {
		return fmt.Errorf("sheet apiserver: %s", res.Error)
	}
	if out != nil {
		return json.Unmarshal(raw, out)
	}
	return nil
}

func (c *Client) do(req *http.Request, out any) error {
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, 64<<20))
	if err != nil {
		return err
	}
	if res.StatusCode/100 != 2 {
		return fmt.Errorf("sheet apiserver: HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(b)))
	}
	// Apps Script answers errors with an HTML page and 200; JSON or bust.
	if err := json.Unmarshal(b, out); err != nil {
		return fmt.Errorf("sheet apiserver: not JSON (%v): %.200s", err, string(b))
	}
	return nil
}

// Deployments lists the Deployments tab.
func (c *Client) Deployments(ctx context.Context) ([]Deployment, error) {
	rows, err := c.get(ctx, "deployments", nil)
	if err != nil {
		return nil, err
	}
	out := make([]Deployment, 0, len(rows))
	for _, r := range rows {
		out = append(out, Deployment{Name: r.str("name"), Image: r.str("image"), Replicas: r.num("replicas"),
			CPUReq: r.num("cpu_req"), MemReq: r.num("mem_req"), Command: r.str("command"),
			NodeSelector: r.str("node_selector"), Tolerations: r.str("tolerations")})
	}
	return out, nil
}

// Pods lists the Pods tab.
func (c *Client) Pods(ctx context.Context) ([]Pod, error) {
	rows, err := c.get(ctx, "pods", nil)
	if err != nil {
		return nil, err
	}
	out := make([]Pod, 0, len(rows))
	for _, r := range rows {
		out = append(out, Pod{Name: r.str("name"), Deployment: r.str("deployment"), Node: r.str("node"),
			Phase: r.str("phase"), ContainerID: r.str("container_id"), Image: r.str("image"),
			CPUReq: r.num("cpu_req"), MemReq: r.num("mem_req"), Command: r.str("command"),
			NodeIP: r.str("node_ip"), StartedAt: r.str("started_at"), Message: r.str("message"),
			NodeSelector: r.str("node_selector"), Tolerations: r.str("tolerations")})
	}
	return out, nil
}

// Nodes lists the Nodes tab.
func (c *Client) Nodes(ctx context.Context) ([]Node, error) {
	rows, err := c.get(ctx, "nodes", nil)
	if err != nil {
		return nil, err
	}
	out := make([]Node, 0, len(rows))
	for _, r := range rows {
		out = append(out, Node{Name: r.str("name"), IP: r.str("ip"), CPUTotal: r.num("cpu_total"),
			MemTotal: r.num("mem_total"), CPUUsed: r.num("cpu_used"), MemUsed: r.num("mem_used"),
			Status: r.str("status"), LastHeartbeat: r.str("last_heartbeat"), Schedulable: r.schedulable(),
			Labels: r.str("labels"), Taints: r.str("taints")})
	}
	return out, nil
}

// Events lists the Events tab (oldest first).
func (c *Client) Events(ctx context.Context) ([]Event, error) {
	rows, err := c.get(ctx, "events", nil)
	if err != nil {
		return nil, err
	}
	out := make([]Event, 0, len(rows))
	for _, r := range rows {
		out = append(out, Event{TS: r.str("ts"), Kind: r.str("kind"), Object: r.str("object"), Message: r.str("message")})
	}
	return out, nil
}

// Logs returns the shipped log tail of one Sheet pod ("" if none yet).
func (c *Client) Logs(ctx context.Context, pod string) (string, error) {
	rows, err := c.get(ctx, "logs", url.Values{"name": {pod}})
	if err != nil {
		return "", err
	}
	for _, r := range rows {
		if r.str("name") == pod {
			return r.str("tail"), nil
		}
	}
	return "", nil
}

// Apply upserts Deployments rows (skctl apply).
func (c *Client) Apply(ctx context.Context, deps ...Deployment) error {
	return c.post(ctx, map[string]any{"action": "apply", "deployments": deps}, nil)
}

// Scale sets replicas of a Deployment (skctl scale).
func (c *Client) Scale(ctx context.Context, name string, replicas int64) error {
	return c.post(ctx, map[string]any{"action": "scale", "name": name, "replicas": replicas}, nil)
}

// Delete removes a Deployment row (skctl delete).
func (c *Client) Delete(ctx context.Context, name string) error {
	return c.post(ctx, map[string]any{"action": "delete", "name": name}, nil)
}

// Cordon / Uncordon flips a node's schedulable cell.
func (c *Client) Cordon(ctx context.Context, node string, cordon bool) error {
	action := "uncordon"
	if cordon {
		action = "cordon"
	}
	return c.post(ctx, map[string]any{"action": action, "name": node}, nil)
}

// DeletePod marks one Pods row Terminating (kubectl delete pod); its Deployment
// creates a replacement on the next reconcile.
func (c *Client) DeletePod(ctx context.Context, name string) error {
	return c.post(ctx, map[string]any{"action": "deletePod", "name": name}, nil)
}
