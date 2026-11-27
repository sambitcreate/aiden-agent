export default function BlogPost({ params }: { params: Record<string, string> }) {
  return (
    <main>
      <h1 id="post-title">{params.slug}</h1>
    </main>
  );
}
