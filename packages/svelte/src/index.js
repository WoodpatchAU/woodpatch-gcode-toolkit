// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
/*!
 * @woodpatch/gcode-svelte: Woodpatch G-code Toolkit
 * Based on webgcode by Nicolas Raynaud (https://github.com/nraynaud/webgcode).
 *
 * MIT License
 *
 * Copyright (c) 2016 Nicolas Raynaud
 * Copyright (c) 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// @woodpatch/gcode-svelte (parcel 3e, ADR-0030): Svelte 5 components, shipped as
// source. The host's Svelte compiles them, so they work with whichever Vite and Svelte 5
// the host uses. Importing this module loads no three.js and no CodeMirror: each
// component loads its own on mount.
export { default as GcodeEditor } from './GcodeEditor.svelte';
export { default as GcodeViewer } from './GcodeViewer.svelte';
export { default as GcodeWorkbench } from './GcodeWorkbench.svelte';
