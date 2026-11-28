// The app's own button. A design app's route imports it through @app.
export function Button({ children }: { children: string }) {
  return (
    <button className="brand-button" type="button">
      {children}
    </button>
  );
}
