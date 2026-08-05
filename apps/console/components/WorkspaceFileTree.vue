<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import ConsoleEmptyState from './ConsoleEmptyState.vue';

const props = defineProps<{
  files: { relativePath: string; name: string; type: string; sizeBytes: number }[];
}>();

interface TreeNode {
  relativePath: string;
  name: string;
  type: string;
  sizeBytes: number;
  depth: number;
  children: TreeNode[];
}

const expandedDirs = ref<Set<string>>(new Set());

// Auto expand first level
watch(() => props.files, () => {
  const rootDirs = props.files.filter((f: any) => f.type === 'directory' && !f.relativePath.includes('/'));
  rootDirs.forEach((d: any) => expandedDirs.value.add(d.relativePath));
}, { immediate: true, deep: true });

const rootNodes = computed(() => {
  const root: TreeNode = { relativePath: '', name: '', type: 'directory', sizeBytes: 0, depth: -1, children: [] };
  const map = new Map<string, TreeNode>();
  map.set('', root);

  const sortedFiles = [...props.files].sort((a: any, b: any) => a.relativePath.localeCompare(b.relativePath));

  for (const file of sortedFiles) {
    const parts = file.relativePath.split('/');
    const name = parts.pop()!;
    const parentPath = parts.join('/');

    let parent = map.get(parentPath);
    if (!parent) {
      parent = root;
      let currentPath = '';
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        let p = map.get(currentPath);
        if (!p) {
           p = { relativePath: currentPath, name: part, type: 'directory', sizeBytes: 0, depth: i, children: [] };
           map.set(currentPath, p);
           parent.children.push(p);
        }
        parent = p;
      }
    }

    const node: TreeNode = { ...file, depth: parts.length, children: [] };
    map.set(file.relativePath, node);
    parent.children.push(node);
  }

  // Sort children: directories first, then files
  const sortChildren = (node: TreeNode) => {
    node.children.sort((a: any, b: any) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (a.type !== 'directory' && b.type === 'directory') return 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortChildren);
  };
  sortChildren(root);

  return root.children;
});

const flatNodes = computed(() => {
  const result: TreeNode[] = [];
  const traverse = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      result.push(node);
      if (node.type === 'directory' && expandedDirs.value.has(node.relativePath)) {
        traverse(node.children);
      }
    }
  };
  traverse(rootNodes.value);
  return result;
});

const formatSize = (bytes: number) => {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
};

const toggleExpand = (node: TreeNode) => {
  if (node.type === 'directory') {
    const next = new Set(expandedDirs.value);
    if (next.has(node.relativePath)) {
      next.delete(node.relativePath);
    } else {
      next.add(node.relativePath);
    }
    expandedDirs.value = next;
  }
};
</script>

<template>
  <div class="workspace-file-tree">
    <template v-if="flatNodes.length">
      <div
        v-for="node in flatNodes"
        :key="node.relativePath"
        class="tree-node"
        :class="{ 'is-dir': node.type === 'directory' }"
        :style="{ paddingLeft: `${node.depth * 20 + 12}px` }"
        @click="toggleExpand(node)"
      >
        <span class="tree-node-icon">
          <template v-if="node.type === 'directory'">
            <svg v-if="expandedDirs.has(node.relativePath)" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
            <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
          </template>
          <template v-else>
            <svg class="tree-node-file-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>
          </template>
        </span>
        <span class="tree-node-name">{{ node.name }}</span>
        <span class="tree-node-size">{{ formatSize(node.sizeBytes) }}</span>
      </div>
    </template>
    <ConsoleEmptyState v-else compact title="该工作空间没有文件。" />
  </div>
</template>

<style scoped>
.tree-node-file-icon {
  opacity: var(--opacity-60);
}

.workspace-file-tree {
  font-family: var(--font-mono, monospace);
  font-size: 0.85rem;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  overflow: hidden;
}

.tree-node {
  display: flex;
  align-items: center;
  padding: var(--space-1-5) var(--space-3);
  cursor: pointer;
  border-bottom: 1px solid var(--border-subtle);
  transition: background-color 0.15s;
}

.tree-node:last-child {
  border-bottom: none;
}

.tree-node:hover {
  background: var(--bg-subtle);
}

.tree-node-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-right: var(--space-1-5);
  color: var(--text-secondary);
}

.tree-node-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-primary);
}

.tree-node.is-dir .tree-node-name {
  font-weight: 500;
}

.tree-node-size {
  color: var(--text-secondary);
  font-size: 0.75rem;
  margin-left: var(--space-3);
}
</style>
