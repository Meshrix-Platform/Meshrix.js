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

type LibreOfficeConverter struct {
	Binary string
}

func (converter LibreOfficeConverter) Ready() error {
	_, err := exec.LookPath(converter.Binary)
	return err
}

func (converter LibreOfficeConverter) Convert(ctx context.Context, inputPath, workDir string) (string, error) {
	profileDir := filepath.Join(workDir, "profile")
	outputDir := filepath.Join(workDir, "output")
	if err := os.MkdirAll(profileDir, 0o700); err != nil {
		return "", fmt.Errorf("create conversion profile: %w", err)
	}
	if err := os.MkdirAll(outputDir, 0o700); err != nil {
		return "", fmt.Errorf("create conversion output: %w", err)
	}

	profileURL := (&url.URL{Scheme: "file", Path: profileDir}).String()
	command := exec.CommandContext(ctx, converter.Binary,
		"--headless",
		"--nologo",
		"--nodefault",
		"--nolockcheck",
		"--nofirststartwizard",
		"-env:UserInstallation="+profileURL,
		"--convert-to", "pdf:writer_pdf_Export",
		"--outdir", outputDir,
		inputPath,
	)
	command.Env = append(os.Environ(), "HOME="+workDir, "TMPDIR="+workDir)
	command.Stdout = newCappedBuffer(32 << 10)
	command.Stderr = newCappedBuffer(32 << 10)
	command.WaitDelay = 2 * time.Second
	if err := command.Run(); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return "", context.DeadlineExceeded
		}
		if errors.Is(ctx.Err(), context.Canceled) {
			return "", context.Canceled
		}
		return "", errors.New("LibreOffice conversion failed")
	}

	base := filepath.Base(inputPath)
	outputPath := filepath.Join(outputDir, base[:len(base)-len(filepath.Ext(base))]+".pdf")
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
