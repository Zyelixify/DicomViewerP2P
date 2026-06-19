# DicomViewerP2P

A zero-config, serverless desktop application for viewing and sharing DICOM medical imaging studies across local networks. Built as a university research prototype to evaluate the viability of peer-to-peer distribution of medical imaging data without centralized infrastructure.

---

## Overview

DicomViewerP2P removes the need for a PACS server or cloud upload when sharing studies between clinicians or researchers on the same network. Peers discover each other automatically via UDP broadcast, and files are transferred directly over TCP — no configuration, no accounts, no intermediary.

The application also includes a built-in evaluation framework that logs interaction events and computes performance metrics for research analysis as part of my thesis.

---

## Features

### Local DICOM Viewing
- Open any folder containing DICOM files with a single click
- Automatic recursive scanning and DICOM detection (validated against DICM magic bytes)
- Studies grouped by Study → Series → Instances through metadata parsing
- Thumbnail previews within series browser
- Interactive viewport with:
  - Frame slider for multi-image series navigation (+ scroll wheel support)
  - Click-and-drag window/level (contrast) adjustment

### Peer-to-Peer Transfer
- **Zero-config peer discovery** via UDP broadcast on the local network
- **Send**: select one or more studies, choose a discovered peer, and stream files directly
- **Receive**: enable receive mode to accept incoming study offers from peers
- TCP-based binary transfer protocol with 512 KB chunk streaming
- SHA-256 integrity verification per file
- Resumable transfers

### Progressive Review
- Received studies can be opened and reviewed while the transfer is still in progress. New slides are added to the viewer as they are received.
- Transfer status can be continuously monitored as it is ongoing.

### Research Evaluation Metrics
- All user interactions and system events are logged and timestamped for later analysis
- Per-study metrics computed automatically:
  - **TTFIM** — time from study selection to first image rendered
  - Transfer duration and throughput (Mbps)
  - Study completeness percentage
  - Reviewer confidence/adequacy feedback
- Full session summary exportable as JSON
- Optional post-session survey link (configurable via `.env`)

### Multi-Instance Support
- Run multiple isolated app instances on the same machine for testing
- Separate user data directories and network ports per instance

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop framework | [Electron](https://www.electronjs.org/) 34 |
| Frontend framework | [React](https://react.dev/) 18 + TypeScript |
| Slide rendering | [Cornerstone.js](https://www.cornerstonejs.org/) Core 4.17 |
| DICOM loading | [@cornerstonejs/dicom-image-loader](https://github.com/cornerstonejs/cornerstone3D) 4.17 |
| DICOM parsing | [dicom-parser](https://github.com/cornerstonejs/dicomParser) 1.8 |
| Build tooling | [electron-vite](https://electron-vite.org/) 3 + [Vite](https://vitejs.dev/) 6 |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      Electron Application                    │
├─────────────────────────┬────────────────────────────────────┤
│   Main Process (Node)   │   Renderer Process (Chromium)      │
├─────────────────────────┼────────────────────────────────────┤
│  • UDP peer discovery   │  • React UI                        │
│  • TCP file transfer    │  • Cornerstone.js viewer           │
│  • DICOM folder scan    │  • Series browser + thumbnails     │
│  • Evaluation metrics   │  • Discovery & transfer modal      │
│  • IPC handlers         │  • Workflow status rail            │
└─────────────────────────┴────────────────────────────────────┘
          ↕  IPC (context-isolated preload bridge)
          ↓  UDP/37861  — peer presence broadcast
          ↓  TCP/37862  — study file streaming
```

The renderer has no direct filesystem or network access; all I/O is proxied through IPC handlers in the main process with strict path allowlisting and input validation.

### Transfer Protocol (TCP)

```
Sender                          Receiver
  │── hello ─────────────────────→ │
  │── studyOffer ──────────────→   │
  │                  studyAccept ──│
  │               manifestRequest ─│
  │── manifestResponse ──────────→ │
  │── fileOffer ────────────────→  │
  │── fileChunkBinary (x N) ─────→ │  (512 KB chunks)
  │── fileComplete ─────────────→  │
  │   (repeat per file)            │
```

---

## Getting Started

### Install

```bash
git clone https://github.com/Zyelixify/PeerToPeerDicomViewer.git
cd PeerToPeerDicomViewer
npm install
```

### Development

```bash
npm run dev
```

### Build

```bash
npm run build
```

### Package (Windows)

```bash
# Installer
npm run dist:win

# Portable executable
npm run dist:portable
```

Output goes to `release/`.

---

### Multi-Instance (for testing)

```bash
# Instance 1
npx electron . --instance-id=alpha --transfer-port=37862

# Instance 2
npx electron . --instance-id=beta  --transfer-port=37863
```
