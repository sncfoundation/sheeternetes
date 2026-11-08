// Package testsheet starts hack/local-apiserver.js (the real Code.gs control
// plane on an in-memory Sheet) for Go tests.
package testsheet

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// Token is the default token of Code.gs.
const Token = "CHANGE_ME_super_secret"

// Root is the repository root.
func Root() string {
	_, f, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(f), "..", "..")
}

// Start launches a fresh local apiserver (no sample deployments) and returns its URL.
func Start(t testing.TB) string {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is required to run the Code.gs control plane")
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	cmd := exec.Command("node", filepath.Join(Root(), "hack", "local-apiserver.js"))
	cmd.Env = append(os.Environ(), fmt.Sprintf("PORT=%d", port), "NO_SAMPLES=1")
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() })
	url := fmt.Sprintf("http://127.0.0.1:%d/exec", port)
	for i := 0; i < 100; i++ {
		if res, err := http.Get(url + "?token=" + Token + "&kind=nodes"); err == nil {
			res.Body.Close()
			return url
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("local apiserver did not start")
	return ""
}

// Heartbeat plays kubelet.sh once: register/refresh `node` and report the given
// pods (name -> log tail) as running. Returns the pods the apiserver wants there.
func Heartbeat(t testing.TB, url, node string, running map[string]string) []map[string]any {
	t.Helper()
	pods := []map[string]any{}
	for name, logs := range running {
		pods = append(pods, map[string]any{"name": name, "phase": "Running", "container_id": "cid-" + name, "logs": logs})
	}
	b, _ := json.Marshal(map[string]any{"token": Token, "node": node, "ip": "10.1.2.3",
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
