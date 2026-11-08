// Package testsheet starts hack/local-apiserver.js (the real Code.gs control
// plane on an in-memory Sheet) for Go tests.
package testsheet

import (
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
