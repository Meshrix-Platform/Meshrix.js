//go:build !linux

package service

func fixtureFilesystemExecutable(directory string) bool { return true }
