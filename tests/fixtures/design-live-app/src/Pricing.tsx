function PriceCard({ name, price }: { name: string; price: string }) {
  return (
    <section className="price-card">
      <h2>{name}</h2>
      <p>{price}</p>
    </section>
  );
}

export function Pricing() {
  return (
    <main>
      <h1 id="pricing-title">Pricing</h1>
      <PriceCard name="Starter" price="$0" />
      <PriceCard name="Team" price="$12" />
    </main>
  );
}
