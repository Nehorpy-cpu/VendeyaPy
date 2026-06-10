export default function HomePage() {
  return (
    <main className="min-h-screen flex items-center justify-center p-8">
      <div className="max-w-2xl text-center space-y-4">
        <h1 className="text-4xl font-bold text-brand-700">VentaporWhatsapp</h1>
        <p className="text-lg text-gray-600">
          Panel admin de la plataforma. En construcción — ver ARCHITECTURE.md §10.
        </p>
        <p className="text-sm text-gray-500">
          Bloque actual: <span className="font-mono">0 — Fundación</span>
        </p>
      </div>
    </main>
  );
}
