import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Hydra",
    short_name: "Hydra",
    description: "Many heads. One console. A live console for local CLI coding agents.",
    start_url: "/",
    display: "standalone",
    background_color: "#12151c",
    theme_color: "#12151c",
    icons: [
      { src: "/brand/hydra-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/brand/hydra-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/brand/hydra-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
