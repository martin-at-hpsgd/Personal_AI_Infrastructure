# TELOS Dashboard Template

A reusable Next.js dashboard template with Tokyo Night Day theme, shadcn/ui components, and built-in AI chat that runs through your local LifeOS install.

## Features

- **Modern Stack**: Next.js 15, React 19, TypeScript, Tailwind CSS 4
- **Beautiful Design**: Tokyo Night Day theme with professional gradients
- **Pre-built Components**: shadcn/ui Card, Badge, Button, Progress, Table components
- **AI Chat**: Built-in Ask page that runs through the local LifeOS inference tool
- **Dynamic File System**: Automatic file discovery, navigation, and editing
- **File Upload**: Drag-and-drop interface for uploading .md and .csv files
- **File Editing**: In-browser editing with save functionality
- **Responsive Layout**: Fixed sidebar navigation with responsive main content
- **Template Structure**: Easy-to-customize pages with TODO comments

## Pages Included

1. **Overview** (`/`) - Dashboard overview with hero section, metrics grid, and summary
2. **Ask** (`/ask`) - AI chatbot with full TELOS context, run through the local LifeOS inference tool
3. **Add File** (`/add-file`) - Drag-and-drop file upload interface for .md and .csv files
4. **File Viewer** (`/file/[slug]`) - Dynamic file viewer with edit capabilities for all TELOS files
5. **Projects** (`/projects`) - Project tracking with budget, progress, and status (template example)
6. **Teams** (`/teams`) - Team management and coverage tracking (template example)
7. **Vulnerabilities** (`/vulnerabilities`) - Security vulnerability tracking (template example)
8. **Progress** (`/progress`) - Progress tracking toward goals (template example)

## Getting Started

### 1. Copy the Template

```bash
cp -r ~/.claude/skills/Telos/DashboardTemplate /path/to/your/project
cd /path/to/your/project
```

### 2. Install Dependencies

```bash
bun install
```

**Note**: The template requires `@radix-ui/react-slot` for the Button component. It should install automatically with `bun install`. If you encounter issues, install it manually:

```bash
bun add @radix-ui/react-slot
```

### 3. Configure Environment

No API key is needed. The Ask panel runs your question through LifeOS's `LIFEOS/TOOLS/Inference.ts` on this machine, which uses the Claude login you already have. `.env.example` is kept for your own additions; copying it to `.env` is optional:

```bash
cp .env.example .env
```

### 4. Customize Your Dashboard

#### Update Branding

**File**: `components/sidebar.tsx`
- Line 24-26: Replace `{/* TODO: Add your app name */}` with your app name
- Line 54: Update footer text

**File**: `app/layout.tsx`
- Line 6-7: Update metadata title and description

#### Add Your Data

Each page includes TODO comments marking where to add your data:

**Overview Page** (`app/page.tsx`):
- Line 7-13: Add metrics data structure
- Lines with `{/* TODO: ... */}`: Replace with your content

**Projects Page** (`app/projects/page.tsx`):
- Line 6-17: Add projects data structure
- Map over your projects array to render cards

**Teams Page** (`app/teams/page.tsx`):
- Line 6-13: Add teams data structure
- Map over teams to populate grid

**Vulnerabilities Page** (`app/vulnerabilities/page.tsx`):
- Line 6-14: Add vulnerabilities data structure
- Map over data to populate table

**Progress Page** (`app/progress/page.tsx`):
- Line 6-12: Add progress metrics structure
- Map over categories to show progress

#### Customize Data Structure

**File**: `lib/data.ts`
- Replace example data with your actual data
- Add TypeScript interfaces for type safety

**Example**:
```typescript
// lib/data.ts
export interface Project {
  id: string
  name: string
  description: string
  priority: "Critical" | "High" | "Medium" | "Low"
  status: "In Progress" | "Planning" | "Complete"
  completion: number
  budget: {
    oneTime: number
    monthly: number
  }
}

export const projects: Project[] = [
  // Your projects here
]
```

### 5. Run Development Server

```bash
bun dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Tokyo Night Day Theme

The template uses a professionally-designed color palette:

- **Primary**: `#2e7de9` (Blue)
- **Accent**: `#9854f1` (Purple)
- **Success**: `#33b579` (Green)
- **Warning**: `#f0a020` (Orange)
- **Destructive**: `#f52a65` (Red)
- **Background**: `#ffffff` (White)
- **Foreground**: `#1a1b26` (Dark)

Colors are defined in:
- `tailwind.config.ts` - Tailwind theme extension
- `app/globals.css` - CSS variables

## AI Chat Integration

The Ask page runs your question through the local LifeOS inference tool:

**Frontend**: `app/ask/page.tsx`
- React state management for messages
- Beautiful chat UI with user/assistant bubbles
- Loading states and error handling

**Backend**: `app/api/chat/route.ts`
- Next.js API route
- Runs `LIFEOS/TOOLS/Inference.ts` (the medium level) with your TELOS as context
- Handles errors gracefully

No environment variable is required. The route needs a local LifeOS install, so Ask works when the dashboard runs on your own machine.

## Dynamic File System

The template includes a complete file management system for TELOS files (markdown and CSV):

### File Discovery
- **Automatic scanning**: The dashboard automatically discovers all `.md` and `.csv` files in the TELOS directory
- **Dynamic navigation**: Every file becomes a clickable navigation item in the sidebar
- **Real-time updates**: File count and list update automatically when new files are uploaded

**Implementation**: `lib/telos-data.ts`
- `getAllTelosData()` - Scans TELOS directory and returns all files
- `getTelosFileCount()` - Returns total file count
- `getTelosFileList()` - Returns array of filenames
- Resolves the TELOS directory as `<configRoot>/LIFEOS/USER/TELOS/` (`configRoot` is `$CLAUDE_CONFIG_DIR`, else `~/.claude`; `$LIFEOS_USER_DIR` replaces `<configRoot>/LIFEOS/USER` when set)
- Searches that directory for `.md` files
- Searches its optional `data/` subfolder for `.csv` files; the folder need not exist, and the first CSV upload creates it

### File Upload
**Page**: `app/add-file/page.tsx`
- Drag-and-drop interface
- Button-based file selection
- Support for `.md` and `.csv` files
- Real-time upload status tracking
- Automatic sidebar refresh after upload

**API**: `app/api/upload/route.ts`
- Handles file upload via FormData
- Validates file types
- Saves to appropriate TELOS directory
- Logs uploads to `updates.md`

### File Viewing and Editing
**Page**: `app/file/[slug]/page.tsx`
- Dynamic route for any TELOS file
- Displays markdown files with ReactMarkdown rendering
- Displays CSV files as formatted tables
- Edit mode with textarea editor
- Save functionality with success/error feedback

**API Endpoints**:
- `app/api/file/get/route.ts` - Fetches individual file content
- `app/api/file/save/route.ts` - Saves edited content back to disk under the shared TELOS lock, after a `Backups/<name>.dashboard-<stamp>` copy; refuses an edit inside an AUTOMATED region

**Features**:
- Toggle between view and edit modes
- Syntax-highlighted editing (monospace font)
- Save/Cancel buttons with visual feedback
- Success message after save
- Automatic content refresh after save
- Logs all edits to `updates.md`

### Sidebar Integration
**File**: `components/sidebar.tsx`
- Static navigation (Overview, Ask, Add File)
- Dynamic file navigation section
- File count badge
- Icon differentiation (FileText for .md, Table for .csv)
- Active state highlighting
- Scrollable file list

**Event System**:
```typescript
// Dispatched after file upload
window.dispatchEvent(new CustomEvent('telosFileUploaded', {
  detail: { filename: 'example.md' }
}))

// Listened to by sidebar for automatic refresh
window.addEventListener('telosFileUploaded', handleFileUploaded)
```

## Component Library

All UI components are in `components/ui/`:

- **Card**: Container component with header and content
- **Badge**: Status/label indicator with variants
- **Button**: Interactive button with multiple variants and sizes
- **Progress**: Progress bar component
- **Table**: Responsive table with header and rows

**Usage Example**:
```tsx
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

<Card>
  <CardHeader>
    <CardTitle>Title</CardTitle>
  </CardHeader>
  <CardContent>
    <Badge variant="primary">Status</Badge>
    <Button variant="primary" onClick={handleClick}>
      Click Me
    </Button>
  </CardContent>
</Card>
```

## Project Structure

```
dashboard-template/
├── app/
│   ├── api/
│   │   ├── chat/
│   │   │   └── route.ts          # AI chat API endpoint
│   │   ├── file/
│   │   │   ├── get/
│   │   │   │   └── route.ts      # Fetch individual file content
│   │   │   └── save/
│   │   │       └── route.ts      # Save edited file content
│   │   ├── files/
│   │   │   └── count/
│   │   │       └── route.ts      # Get file count and list
│   │   └── upload/
│   │       └── route.ts          # File upload handler
│   ├── add-file/
│   │   └── page.tsx              # File upload page
│   ├── ask/
│   │   └── page.tsx              # AI chatbot page
│   ├── file/
│   │   └── [slug]/
│   │       └── page.tsx          # Dynamic file viewer/editor
│   ├── projects/
│   │   └── page.tsx              # Projects page (template)
│   ├── teams/
│   │   └── page.tsx              # Teams page (template)
│   ├── vulnerabilities/
│   │   └── page.tsx              # Vulnerabilities page (template)
│   ├── progress/
│   │   └── page.tsx              # Progress page (template)
│   ├── globals.css               # Global styles
│   ├── layout.tsx                # Root layout
│   └── page.tsx                  # Overview page
├── components/
│   ├── ui/
│   │   ├── card.tsx              # Card component
│   │   ├── badge.tsx             # Badge component
│   │   ├── button.tsx            # Button component
│   │   ├── progress.tsx          # Progress bar
│   │   └── table.tsx             # Table component
│   └── sidebar.tsx               # Navigation sidebar
├── lib/
│   ├── data.ts                   # Data definitions
│   ├── telos-data.ts             # TELOS file system utilities
│   └── utils.ts                  # Utility functions
├── .env                          # Environment variables (gitignored)
├── .env.example                  # Environment template
├── .gitignore                    # Git ignore rules
├── next.config.mjs               # Next.js configuration
├── package.json                  # Dependencies
├── postcss.config.mjs            # PostCSS configuration
├── tailwind.config.ts            # Tailwind configuration
├── tsconfig.json                 # TypeScript configuration
└── README.md                     # This file
```

## Customization Tips

### Add New Pages

1. Create page directory: `app/your-page/`
2. Create page file: `app/your-page/page.tsx`
3. Add to sidebar navigation in `components/sidebar.tsx`
4. Import appropriate icon from `lucide-react`

### Modify Theme Colors

Edit `tailwind.config.ts`:
```typescript
colors: {
  primary: "#your-color",
  accent: "#your-color",
  // ...
}
```

### Change Sidebar Branding

Edit `components/sidebar.tsx`:
- Line 24-26: App name
- Line 54: Footer text
- Line 20: Background gradient colors

### Add Data Loading

Replace static data with API calls:

```typescript
// In any page
async function getData() {
  const res = await fetch('/api/your-endpoint')
  return res.json()
}

export default async function Page() {
  const data = await getData()
  // ...
}
```

## Development

**Run dev server**:
```bash
bun dev
```

**Build for production**:
```bash
bun run build
```

**Start production server**:
```bash
bun start
```

**Type checking**:
```bash
bunx tsc --noEmit
```

## Deployment

This template works with any Next.js hosting platform:

- **Vercel**: `vercel deploy`
- **Cloudflare Pages**: Connect to Git repo
- **Netlify**: Connect to Git repo
- **Docker**: Use standard Next.js Dockerfile

A hosted copy has no LifeOS install behind it, so the Ask panel does not work there; the file views do. Keep Ask on your local run.

## Tech Stack

- **Framework**: Next.js 15.5
- **React**: 19.2
- **TypeScript**: 5.x
- **Styling**: Tailwind CSS 4.1
- **UI Components**: shadcn/ui (custom implementation)
- **Icons**: Lucide React
- **AI**: LifeOS `Inference.ts` (medium level, your own Claude login)
- **Package Manager**: Bun (also works with npm/yarn/pnpm)

## License

This template is part of the TELOS skill system and is free to use for any purpose.

## Support

This is a template - customize it to fit your needs! All pages include TODO comments marking where to add your data and content.

For questions about the Anthropic API, see: https://docs.anthropic.com/
