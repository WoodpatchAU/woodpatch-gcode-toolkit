// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

// The components compile with the Svelte this package is tested against: the PEER FLOOR
// (ADR-0030; a test checks the two agree). jsdom stands in for the browser; three.js
// and Canvas 2D are replaced with recording fakes in the tests (jsdom has no WebGL).
export default defineConfig({
  plugins: [svelte()],
  resolve: { conditions: ['browser'] },
  test: { environment: 'jsdom', include: ['src/**/*.test.ts'], setupFiles: ['test/setup.ts'] },
});
