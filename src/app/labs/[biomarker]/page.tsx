import { PlaceholderPage } from "@/components/placeholder-page";

export default async function BiomarkerPage({
  params,
}: {
  params: Promise<{ biomarker: string }>;
}) {
  const { biomarker } = await params;
  const slug = decodeURIComponent(biomarker);
  return (
    <PlaceholderPage
      title={`Lab: ${slug}`}
      description={`Trend history and reference-range bands for the "${slug}" biomarker.`}
    />
  );
}
