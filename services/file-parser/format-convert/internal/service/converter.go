package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

type Converter interface {
	Convert(context.Context, string, string) (string, error)
	Ready() error
}

// converterEnvAllowlist lists the only parent environment variables inherited by
// the converter subprocess. Service secrets, cloud credentials, and other
// deployment-specific variables must never reach the conversion sandbox.
var converterEnvAllowlist = []string{"LANG", "LC_ALL", "LC_CTYPE", "TZ"}

func converterEnvironment(workDir string) []string {
	env := make([]string, 0, len(converterEnvAllowlist)+3)
	for _, key := range converterEnvAllowlist {
		value, present := os.LookupEnv(key)
		if !present {
			continue
		}
		env = append(env, key+"="+value)
	}
	env = append(env, "PATH=/usr/bin:/bin")
	return append(env, "HOME="+workDir, "TMPDIR="+workDir)
}

type LibreOfficeConverter struct {
	Binary string
}

func (converter LibreOfficeConverter) Ready() error {
	workDir, err := os.MkdirTemp("", "converter-readiness-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(workDir)
	command, err := sandboxCommand(context.Background(), converter.Binary, workDir, []string{"--version"})
	if err != nil {
		return err
	}
	command.Dir = workDir
	isolateProcessLifetime(command)
	command.Env = converterRuntimeEnvironment(workDir, converter.Binary)
	command.Stdout = newCappedBuffer(1024)
	command.Stderr = newCappedBuffer(1024)
	err = command.Run()
	stopProcessDescendants(command)
	if err != nil {
		return errors.New("converter isolation unavailable")
	}
	return nil
}

func (converter LibreOfficeConverter) Convert(ctx context.Context, inputPath, workDir string) (string, error) {
	profileDir := filepath.Join(workDir, "profile")
	outputDir := filepath.Join(workDir, "output")
	if err := os.MkdirAll(filepath.Join(profileDir, "user"), 0o700); err != nil {
		return "", fmt.Errorf("create conversion profile: %w", err)
	}
	if err := os.MkdirAll(outputDir, 0o700); err != nil {
		return "", fmt.Errorf("create conversion output: %w", err)
	}

	// Disable macros and automatic linked-content updates for both legacy DOC and OOXML.
	profileSettings := `<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item></oor:items>`
	if err := os.WriteFile(filepath.Join(profileDir, "user", "registrymodifications.xcu"), []byte(profileSettings), 0600); err != nil {
		return "", errors.New("create safe Office profile")
	}

	profileURL := (&url.URL{Scheme: "file", Path: profileDir}).String()
	arguments := []string{
		"--headless",
		"--nologo",
		"--nodefault",
		"--nolockcheck",
		"--nofirststartwizard",
		"-env:UserInstallation=" + profileURL,
		"--convert-to", "pdf:writer_pdf_Export",
		"--outdir", outputDir,
		inputPath,
	}
	if err := runOfficeSandbox(ctx, converter.Binary, workDir, arguments); err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", errors.New("LibreOffice conversion failed")
	}

	base := filepath.Base(inputPath)
	outputPath := filepath.Join(outputDir, base[:len(base)-len(filepath.Ext(base))]+".pdf")
	info, err := os.Lstat(outputPath)
	if err != nil || !info.Mode().IsRegular() {
		return "", errors.New("conversion output must be a regular PDF")
	}
	content, err := os.Open(outputPath)
	if err != nil {
		return "", errors.New("LibreOffice did not produce a PDF")
	}
	defer content.Close()
	header := make([]byte, 5)
	if _, err := content.Read(header); err != nil || !bytes.Equal(header, []byte("%PDF-")) {
		return "", errors.New("conversion output is not a PDF")
	}
	return outputPath, nil
}

// The direct headless executable replaces oosplash without requiring procfs.
// LibreOffice's EXITHELPER_NORMAL_RESTART (81) requests restart with unchanged
// arguments before document processing. Preserve the same profile and sandbox;
// crash status 79 and ordinary failures are never replayed.
func runOfficeSandbox(ctx context.Context, binary, workDir string, arguments []string) error {
	executable, resolveErr := converterExecutable(binary)
	if resolveErr != nil {
		return resolveErr
	}
	for {
		command, err := sandboxCommand(ctx, binary, workDir, arguments)
		if err != nil {
			return err
		}
		command.Dir = workDir
		isolateProcessLifetime(command)
		command.Env = converterRuntimeEnvironment(workDir, binary)
		command.Stdout = newCappedBuffer(32 << 10)
		command.Stderr = newCappedBuffer(32 << 10)
		command.WaitDelay = 2 * time.Second
		err = command.Run()
		stopProcessDescendants(command)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		var exit *exec.ExitError
		if filepath.Base(executable) == "soffice.bin" && errors.As(err, &exit) && exit.ExitCode() == 81 {
			continue
		}
		return err
	}
}

type cappedBuffer struct {
	buffer bytes.Buffer
	limit  int
}

func newCappedBuffer(limit int) *cappedBuffer {
	return &cappedBuffer{limit: limit}
}

func (buffer *cappedBuffer) Write(value []byte) (int, error) {
	originalLength := len(value)
	remaining := buffer.limit - buffer.buffer.Len()
	if remaining > 0 {
		if len(value) > remaining {
			value = value[:remaining]
		}
		_, _ = buffer.buffer.Write(value)
	}
	return originalLength, nil
}
