export function shouldTraverseChildFolder(currentDepth: number, maxDepth: number): boolean {
	return maxDepth < 0 || currentDepth < maxDepth;
}
