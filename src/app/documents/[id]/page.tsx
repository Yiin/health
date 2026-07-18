import { PlaceholderPage } from "@/components/placeholder-page";

export default async function DocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <PlaceholderPage
      title={`Document ${id}`}
      description="Document detail — extracted data, provenance, and editable metadata."
    />
  );
}
