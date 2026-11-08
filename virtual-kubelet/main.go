// sheeternetes-vk: a Virtual Kubelet that registers a Google Sheet as a Node in a
// real Kubernetes cluster. Pods that select it (nodeSelector + toleration on
// sheeternetes.io/sheet) run on the Sheeternetes cluster behind the spreadsheet.
//
//	SHEET_URL=https://script.google.com/macros/s/XXXX/exec SHEET_TOKEN=... \
//	  sheeternetes-vk --nodename sheet
package main

import (
	"context"
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
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/sncfoundation/sheeternetes/internal/sheetapi"
	"github.com/sncfoundation/sheeternetes/virtual-kubelet/provider"
	"github.com/virtual-kubelet/virtual-kubelet/node"
	"github.com/virtual-kubelet/virtual-kubelet/node/nodeutil"
	"k8s.io/client-go/kubernetes"
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	nodeName := flag.String("nodename", env("VK_NODE_NAME", "sheeternetes"), "name of the virtual node")
	sheetURL := flag.String("sheet-url", env("SHEET_URL", ""), "Sheeternetes apiserver (Apps Script /exec URL)")
	token := flag.String("sheet-token", env("SHEET_TOKEN", "CHANGE_ME_super_secret"), "apiserver token")
	listen := flag.String("listen", env("VK_LISTEN", ":10250"), "kubelet API (logs) listen address")
	internalIP := flag.String("internal-ip", env("VK_INTERNAL_IP", ""), "node InternalIP the cluster uses to reach the kubelet API")
	certFile := flag.String("tls-cert", env("VK_TLS_CERT", ""), "serving cert (default: self-signed)")
	keyFile := flag.String("tls-key", env("VK_TLS_KEY", ""), "serving key")
	kubeconfig := flag.String("kubeconfig", env("KUBECONFIG", ""), "kubeconfig (empty: in-cluster)")
	flag.Parse()
	if *sheetURL == "" {
		fmt.Fprintln(os.Stderr, "set --sheet-url or SHEET_URL")
		os.Exit(2)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	sheet := sheetapi.New(*sheetURL, *token)
	capacity, err := provider.Capacity(ctx, sheet)
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot reach the sheet:", err)
		os.Exit(1)
	}
	_, portStr, _ := net.SplitHostPort(*listen)
	port, _ := strconv.Atoi(portStr)

	tlsOpts := []func(*tls.Config) error{}
	if *certFile != "" {
		tlsOpts = append(tlsOpts, nodeutil.WithKeyPairFromPath(*certFile, *keyFile))
	} else {
		tlsOpts = append(tlsOpts, selfSigned(*nodeName, *internalIP))
	}

	mux := http.NewServeMux()
	vk, err := nodeutil.NewNode(*nodeName,
		func(cfg nodeutil.ProviderConfig) (nodeutil.Provider, node.NodeProvider, error) {
			provider.ConfigureNode(cfg.Node, capacity, *internalIP, int32(port))
			return provider.New(sheet, *nodeName), nil, nil
		},
		func(c *nodeutil.NodeConfig) error {
			c.KubeconfigPath = *kubeconfig
			c.HTTPListenAddr = *listen
			c.Handler = mux
			return nil
		},
		nodeutil.WithClient(mustClient(*kubeconfig)),
		nodeutil.WithTLSConfig(tlsOpts...),
		nodeutil.AttachProviderRoutes(mux),
	)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	go func() {
		if err := vk.Run(ctx); err != nil && ctx.Err() == nil {
			fmt.Fprintln(os.Stderr, "virtual kubelet stopped:", err)
			os.Exit(1)
		}
	}()
	if err := vk.WaitReady(ctx, time.Minute); err != nil {
		fmt.Fprintln(os.Stderr, "node never became ready:", err)
		os.Exit(1)
	}
	fmt.Printf("node %s is Ready: the spreadsheet at %s is now part of your cluster\n", *nodeName, *sheetURL)
	<-ctx.Done()
}

func mustClient(kubeconfig string) *kubernetes.Clientset {
	c, err := nodeutil.ClientsetFromEnv(kubeconfig)
	if err != nil {
		fmt.Fprintln(os.Stderr, "kubernetes client:", err)
		os.Exit(1)
	}
	return c
}

// selfSigned serves the kubelet API with an in-memory self-signed certificate;
// the kube-apiserver does not verify kubelet serving certs unless configured to.
func selfSigned(name, ip string) func(*tls.Config) error {
	return func(cfg *tls.Config) error {
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			return err
		}
		tmpl := &x509.Certificate{
			SerialNumber: big.NewInt(time.Now().UnixNano()),
			Subject:      pkix.Name{CommonName: name, Organization: []string{"Sheet-Native Computing Foundation"}},
			NotBefore:    time.Now().Add(-time.Hour),
			NotAfter:     time.Now().Add(10 * 365 * 24 * time.Hour),
			KeyUsage:     x509.KeyUsageDigitalSignature,
			ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
			DNSNames:     []string{name},
		}
		if parsed := net.ParseIP(ip); parsed != nil {
			tmpl.IPAddresses = []net.IP{parsed}
		}
		der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
		if err != nil {
			return err
		}
		cfg.Certificates = append(cfg.Certificates, tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key})
		return nil
	}
}
