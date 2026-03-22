import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function githubPagesBase(): string {
  const repository = process.env.GITHUB_REPOSITORY?.split('/')[1]
  if (!process.env.GITHUB_ACTIONS || !repository) {
    return '/'
  }

  return repository.endsWith('.github.io') ? '/' : `/${repository}/`
}

export default defineConfig({
  base: githubPagesBase(),
  plugins: [react()],
})
