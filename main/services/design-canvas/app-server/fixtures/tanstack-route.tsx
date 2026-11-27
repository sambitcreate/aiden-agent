// @ts-nocheck -- a verbatim documentation example, read as bytes by app-page-files-core.test.ts; never imported.
// Source: node_modules/@tanstack/router-core/skills/router-core/data-loading/SKILL.md
// (@tanstack/router-core 1.171.15), "## Setup", the first ```tsx block, copied unchanged below.
// src/routes/posts.tsx
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/posts')({
  loader: () => fetchPosts(),
  component: PostsComponent,
})

function PostsComponent() {
  const posts = Route.useLoaderData()
  return (
    <ul>
      {posts.map((post) => (
        <li key={post.id}>{post.title}</li>
      ))}
    </ul>
  )
}
