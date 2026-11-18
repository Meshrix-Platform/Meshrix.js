package service

import (
	"bytes"
	"context"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// The test binary doubles as a static, dependency-free sandbox probe. Only
// synthetic test-owned paths or local listeners are supplied by the parent.
func init() {
	if len(os.Args) != 3 {
		return
	}
	switch os.Args[1] {
	case "--sandbox-probe-read":
		if _, err := os.ReadFile(os.Args[2]); err == nil {
			os.Exit(1)
		}
		os.Exit(0)
	case "--sandbox-probe-write":
		if err := os.WriteFile(os.Args[2], []byte("changed"), 0600); err == nil {
			os.Exit(1)
		}
		os.Exit(0)
	case "--sandbox-probe-wait":
		if err := os.WriteFile(os.Args[2], []byte("ready"), 0600); err != nil {
			os.Exit(1)
		}
		for {
			time.Sleep(time.Hour)
		}
	case "--sandbox-probe-network":
		connection, err := net.DialTimeout("tcp", os.Args[2], time.Second)
		if err == nil {
			connection.Close()
			os.Exit(1)
		}
		os.Exit(0)
	}
}

func TestSandboxRuntimeRejectsOtherFilesystemAndNetwork(t *testing.T) {
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		t.Skip("sandbox adapter unavailable")
	}
	binary, err := os.Executable()
	if err != nil {
		t.Fatal("test executable unavailable")
	}
	protected := filepath.Join(t.TempDir(), "synthetic.txt")
	if err := os.WriteFile(protected, []byte("unchanged"), 0600); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	for _, probe := range []struct{ mode, target string }{
		{"--sandbox-probe-read", protected},
		{"--sandbox-probe-write", protected},
		{"--sandbox-probe-network", listener.Addr().String()},
	} {
		t.Run(probe.mode, func(t *testing.T) {
			work := t.TempDir()
			command, err := sandboxCommand(context.Background(), binary, work, []string{probe.mode, probe.target})
			if err != nil {
				t.Fatal("sandbox setup unavailable")
			}
			command.Dir = work
			command.Env = converterEnvironment(work)
			isolateProcessLifetime(command)
			var diagnostic bytes.Buffer
			command.Stderr = &diagnostic
			err = command.Run()
			stopProcessDescendants(command)
			if err != nil {
				t.Fatalf("sandbox probe failure: runtimeFatal=%t syscall=%t permission=%t aborted=%t", strings.Contains(diagnostic.String(), "fatal"), strings.Contains(diagnostic.String(), "sysctl"), strings.Contains(diagnostic.String(), "permitted"), strings.Contains(err.Error(), "abort"))
			}
		})
	}
	data, err := os.ReadFile(protected)
	if err != nil || string(data) != "unchanged" {
		t.Fatal("sandbox changed another workspace")
	}
}

func TestSandboxAdmittedProcessContinuesUntilUserCancellation(t *testing.T) {
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		t.Skip("sandbox adapter unavailable")
	}
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	work := t.TempDir()
	marker := filepath.Join(work, "synthetic-ready")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	command, err := sandboxCommand(ctx, binary, work, []string{"--sandbox-probe-wait", marker})
	if err != nil {
		t.Fatal("sandbox unavailable")
	}
	command.Env = converterEnvironment(work)
	command.Dir = work
	isolateProcessLifetime(command)
	if err := command.Start(); err != nil {
		t.Fatal("sandbox launch failed")
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if _, err := os.Stat(marker); err == nil {
				if _, deadline := ctx.Deadline(); deadline {
					t.Error("active sandbox received an internal duration deadline")
				}
				cancel()
				if err := <-done; err == nil {
					t.Error("user cancellation did not terminate child")
				}
				stopProcessDescendants(command)
				return
			}
		case <-done:
			stopProcessDescendants(command)
			t.Fatal("sandbox ended viable operation before user cancellation")
		}
	}
}
