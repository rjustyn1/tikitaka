import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// React Testing Library does not auto-clean when globals come from config
// rather than an import, so unmount between tests explicitly.
afterEach(() => cleanup());
