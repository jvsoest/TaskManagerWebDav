import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function githubPagesBase(): string {
  const repository = process.env.GITHUB_REPOSITORY?.split('/')[1]
  if (!process.env.GITHUB_ACTIONS || !repository) {
    return '/'
  }

  return repository.endsWith('.github.io') ? '/' : `/${repository}/`
}

function gitCommitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return 'unknown'
  }
}

export default defineConfig({
  base: githubPagesBase(),
  define: {
    __BUILD_TIMESTAMP__: JSON.stringify(new Date().toISOString()),
    __BUILD_COMMIT__: JSON.stringify(gitCommitHash()),
  },
  plugins: [react()],
})
