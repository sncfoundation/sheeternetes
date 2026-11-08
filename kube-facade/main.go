// sheeternetes-kube-facade serves the Kubernetes API on top of a Sheeternetes
// spreadsheet, so kubectl and k9s can talk to it.
//
//	SHEET_URL=https://script.google.com/macros/s/XXXX/exec SHEET_TOKEN=... \
//	  sheeternetes-kube-facade --listen 127.0.0.1:6443 --write-kubeconfig sheet.kubeconfig
//	KUBECONFIG=sheet.kubeconfig kubectl get pods
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"flag"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/sncfoundation/sheeternetes/internal/sheetapi"
	"github.com/sncfoundation/sheeternetes/kube-facade/facade"
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

const kubeconfigTmpl = `apiVersion: v1
kind: Config
clusters:
- name: sheeternetes
  cluster:
    server: %s
    insecure-skip-tls-verify: %t
contexts:
- name: sheeternetes
  context:
    cluster: sheeternetes
    user: sheeternetes
    namespace: default
current-context: sheeternetes
users:
- name: sheeternetes
  user:
    token: %q
`

func main() {
	listen := flag.String("listen", env("FACADE_LISTEN", "127.0.0.1:6443"), "address to serve the Kubernetes API on")
	sheetURL := flag.String("sheet-url", env("SHEET_URL", ""), "Sheeternetes apiserver (Apps Script /exec URL)")
	token := flag.String("sheet-token", env("SHEET_TOKEN", "CHANGE_ME_super_secret"), "Sheet apiserver token")
	clientToken := flag.String("token", env("FACADE_TOKEN", ""), "bearer token kubectl must present (empty: none, plain HTTP); "+
		"with a token the API is served over HTTPS with a self-signed certificate, since kubectl never sends tokens over HTTP")
	poll := flag.Duration("poll", 2*time.Second, "how often watches re-read the Sheet")
	kubeconfig := flag.String("write-kubeconfig", "", "write a kubeconfig for this facade to this path")
	rvSource := flag.String("resource-version", "revisions", "where resourceVersions come from: revisions (Google Sheets version history) or counter")
	flag.Parse()
	if *sheetURL == "" {
		fmt.Fprintln(os.Stderr, "set --sheet-url or SHEET_URL")
		os.Exit(2)
	}
	sheet := sheetapi.New(*sheetURL, *token)
	srv := facade.New(sheet)
	srv.Token, srv.Poll = *clientToken, *poll
	if *rvSource == "revisions" {
		srv.Versioner = &facade.Revisions{Source: sheet, TTL: *poll}
	}
	scheme := "http"
	hs := &http.Server{Addr: *listen, Handler: srv, ReadHeaderTimeout: 30 * time.Second}
	if *clientToken != "" {
		scheme = "https"
		cert, err := selfSigned()
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		hs.TLSConfig = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
	}
	if *kubeconfig != "" {
		cfg := fmt.Sprintf(kubeconfigTmpl, scheme+"://"+*listen, scheme == "https", *clientToken)
		if err := os.WriteFile(*kubeconfig, []byte(cfg), 0o600); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
	fmt.Printf("Kubernetes API for %s on %s://%s\n", *sheetURL, scheme, *listen)
	var err error
	if scheme == "https" {
		err = hs.ListenAndServeTLS("", "")
	} else {
		err = hs.ListenAndServe()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func selfSigned() (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: "sheeternetes", Organization: []string{"Sheet-Native Computing Foundation"}},
		NotBefore:    time.Now().Add(-time.Hour), NotAfter: time.Now().Add(365 * 24 * time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames: []string{"localhost", "sheeternetes"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, err
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, nil
}
