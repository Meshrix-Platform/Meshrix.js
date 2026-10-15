//go:build !linux && !darwin

package service

import "os/exec"

func isolateProcessLifetime(command *exec.Cmd) {}

func stopProcessDescendants(command *exec.Cmd) {}
