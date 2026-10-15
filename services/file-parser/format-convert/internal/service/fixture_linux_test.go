//go:build linux

package service

import "syscall"

func fixtureFilesystemExecutable(directory string) bool {
	var info syscall.Statfs_t
	return syscall.Statfs(directory, &info) == nil && info.Flags&syscall.MS_NOEXEC == 0
}
