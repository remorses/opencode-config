// Example: professional PDF report using @react-pdf/renderer.
// Run with: npx tsx generate-pdf.tsx
// Requires: pnpm add @react-pdf/renderer react
// Project must have "type": "module" in package.json.

import React from 'react'
import {
  Document,
  Page,
  View,
  Text,
  Image,
  Font,
  StyleSheet,
  renderToFile,
} from '@react-pdf/renderer'

// ---------------------------------------------------------------------------
// Font: Lora (elegant serif, closest to Georgia) from Google Fonts
// ---------------------------------------------------------------------------
Font.register({
  family: 'Lora',
  fonts: [
    {
      src: 'https://fonts.gstatic.com/s/lora/v37/0QI6MX1D_JOuGQbT0gvTJPa787weuyJG.ttf',
      fontWeight: 400,
    },
    {
      src: 'https://fonts.gstatic.com/s/lora/v37/0QI8MX1D_JOuMw_hLdO6T2wV9KnW-MoFkqg.ttf',
      fontWeight: 400,
      fontStyle: 'italic',
    },
    {
      src: 'https://fonts.gstatic.com/s/lora/v37/0QI6MX1D_JOuGQbT0gvTJPa787zAvCJG.ttf',
      fontWeight: 600,
    },
    {
      src: 'https://fonts.gstatic.com/s/lora/v37/0QI6MX1D_JOuGQbT0gvTJPa787z5vCJG.ttf',
      fontWeight: 700,
    },
  ],
})

Font.registerHyphenationCallback((word) => {
  return [word]
})

// ---------------------------------------------------------------------------
// Styles: clean, professional document. No colors, no decorative elements.
// ---------------------------------------------------------------------------
const s = StyleSheet.create({
  // Page
  page: {
    paddingTop: 72,
    paddingBottom: 64,
    paddingHorizontal: 72,
    fontFamily: 'Lora',
    fontSize: 10.5,
    lineHeight: 1.6,
    color: '#1a1a1a',
  },

  // Page number (centered at bottom of every page)
  pageNumber: {
    position: 'absolute',
    bottom: 36,
    left: 0,
    right: 0,
    fontSize: 9,
    textAlign: 'center',
    color: '#666',
  },

  // Title page
  titleBlock: {
    marginTop: 160,
  },
  title: {
    fontSize: 28,
    fontWeight: 700,
    lineHeight: 1.25,
    marginBottom: 16,
  },
  subtitle: {
    fontSize: 14,
    color: '#444',
    lineHeight: 1.5,
    marginBottom: 32,
  },
  meta: {
    fontSize: 10,
    color: '#666',
    marginBottom: 4,
  },

  // Headings
  h1: {
    fontSize: 22,
    fontWeight: 700,
    marginBottom: 20,
  },
  h2: {
    fontSize: 16,
    fontWeight: 700,
    marginTop: 28,
    marginBottom: 12,
  },
  h3: {
    fontSize: 13,
    fontWeight: 600,
    marginTop: 20,
    marginBottom: 8,
  },

  // Body text
  paragraph: {
    marginBottom: 10,
  },
  bold: {
    fontWeight: 700,
  },

  // Lists
  listItem: {
    flexDirection: 'row' as const,
    marginBottom: 5,
  },
  bullet: {
    width: 16,
  },
  numberedBullet: {
    width: 20,
  },
  listContent: {
    flex: 1,
  },

  // Images
  figure: {
    marginVertical: 16,
  },
  image: {
    width: '100%',
  },
  caption: {
    fontSize: 9,
    color: '#666',
    textAlign: 'center' as const,
    marginTop: 6,
    fontStyle: 'italic',
  },

  // Code blocks
  codeBlock: {
    borderWidth: 0.5,
    borderColor: '#ccc',
    padding: 10,
    marginVertical: 12,
  },
  code: {
    fontFamily: 'Courier',
    fontSize: 9,
    lineHeight: 1.7,
  },
  inlineCode: {
    fontFamily: 'Courier',
    fontSize: 9.5,
  },

  // Tables
  tableRow: {
    flexDirection: 'row' as const,
    borderBottomWidth: 0.5,
    borderBottomColor: '#999',
    paddingVertical: 6,
  },
  tableHeaderCell: {
    flex: 1,
    paddingHorizontal: 8,
    fontSize: 10,
    fontWeight: 700,
  },
  tableCell: {
    flex: 1,
    paddingHorizontal: 8,
    fontSize: 10,
  },
  tableCaption: {
    fontSize: 9,
    color: '#666',
    textAlign: 'center' as const,
    marginTop: 6,
    fontStyle: 'italic',
  },

  // Horizontal rule
  hr: {
    borderBottomWidth: 0.5,
    borderBottomColor: '#999',
    marginVertical: 20,
  },
})

// ---------------------------------------------------------------------------
// Reusable components
// ---------------------------------------------------------------------------

const Bullet = ({ children }: { children: React.ReactNode }) => (
  <View style={s.listItem}>
    <Text style={s.bullet}>•</Text>
    <Text style={s.listContent}>{children}</Text>
  </View>
)

const Numbered = ({ n, children }: { n: number; children: React.ReactNode }) => (
  <View style={s.listItem}>
    <Text style={s.numberedBullet}>{n}.</Text>
    <Text style={s.listContent}>{children}</Text>
  </View>
)

const PageNumber = () => (
  <Text
    fixed
    style={s.pageNumber}
    render={({ pageNumber }) => {
      return `${pageNumber}`
    }}
  />
)

const CodeBlock = ({ children }: { children: string }) => (
  <View style={s.codeBlock}>
    <Text style={s.code}>{children}</Text>
  </View>
)

const TableRow = ({ cells, header }: { cells: string[]; header?: boolean }) => (
  <View style={s.tableRow}>
    {cells.map((cell, i) => (
      <Text key={i} style={header ? s.tableHeaderCell : s.tableCell}>{cell}</Text>
    ))}
  </View>
)

const Figure = ({ src, caption: captionText }: { src: string; caption: string }) => (
  <View style={s.figure} wrap={false}>
    <Image src={src} style={s.image} />
    <Text style={s.caption}>{captionText}</Text>
  </View>
)

// ---------------------------------------------------------------------------
// Sample images (public domain placeholders fetched at render time)
// ---------------------------------------------------------------------------
const IMAGE_WORKSPACE = 'https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=800&q=80'
const IMAGE_CODE = 'https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=600&q=80'

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------
const Report = () => (
  <Document title="Technical Architecture Report" author="Engineering Team">
    {/* Title page */}
    <Page size="A4" style={s.page}>
      <View style={s.titleBlock}>
        <Text style={s.title}>Technical Architecture Report</Text>
        <Text style={s.subtitle}>
          Platform design, infrastructure decisions,{'\n'}
          and performance analysis for Q2 2026.
        </Text>
        <View style={s.hr} />
        <Text style={s.meta}>Prepared by the Engineering Team</Text>
        <Text style={s.meta}>June 2026</Text>
      </View>
    </Page>

    {/* Content pages */}
    <Page size="A4" style={s.page}>
      <PageNumber />

      <Text style={s.h1}>1. Introduction</Text>

      <Text style={s.paragraph}>
        This report describes the technical architecture of the platform as it
        stands at the end of Q2 2026. It covers the major subsystems, their
        responsibilities, and the reasoning behind key design decisions. The
        intended audience is the engineering team and technical stakeholders.
      </Text>

      <Text style={s.paragraph}>
        The platform serves over 50,000 developers across 120 countries. Over
        the past year, usage has grown by approximately 340%, driven primarily by
        the introduction of the type-safe API client and the zero-configuration
        deployment pipeline.
      </Text>

      <Figure
        src={IMAGE_WORKSPACE}
        caption="Figure 1. The development workspace showing the deployment dashboard."
      />

      <Text style={s.h2}>1.1 Scope</Text>

      <Text style={s.paragraph}>
        This document focuses on three areas:
      </Text>

      <Bullet>The API gateway and request routing layer</Bullet>
      <Bullet>The core compute services and their scaling behavior</Bullet>
      <Bullet>The data layer, including primary databases and caching</Bullet>
      <Bullet>Performance benchmarks collected over the past 30 days</Bullet>

      <Text style={s.paragraph}>
        It does not cover the client-side SDK implementation, which is documented
        separately in the SDK reference guide.
      </Text>

      <Text style={s.h2}>1.2 Design Principles</Text>

      <Text style={s.paragraph}>
        The architecture follows a small set of principles that guided every
        decision described in this report:
      </Text>

      <Numbered n={1}>
        <Text style={s.bold}>Stateless compute.</Text> Application servers hold
        no local state. Any instance can handle any request, which simplifies
        scaling and failure recovery.
      </Numbered>
      <Numbered n={2}>
        <Text style={s.bold}>Edge-first routing.</Text> Requests are terminated
        as close to the user as possible. Authentication and rate limiting happen
        at the edge before traffic reaches origin servers.
      </Numbered>
      <Numbered n={3}>
        <Text style={s.bold}>Observable by default.</Text> Every service emits
        structured traces and metrics through OpenTelemetry. There is no opt-in
        step; observability is part of the framework.
      </Numbered>
      <Numbered n={4}>
        <Text style={s.bold}>Incremental adoption.</Text> New features are
        introduced behind feature flags and rolled out gradually, monitored at
        each stage before full release.
      </Numbered>

      <View style={s.hr} />

      <Text style={s.h1} minPresenceAhead={80}>2. System Architecture</Text>

      <Text style={s.paragraph}>
        The platform is organized into three layers. Each layer scales
        independently and communicates through well-defined interfaces. The
        following sections describe each layer in detail.
      </Text>

      <Text style={s.h2}>2.1 API Gateway</Text>

      <Text style={s.paragraph}>
        The gateway runs on Cloudflare Workers, deployed to over 300 edge
        locations. It handles TLS termination, authentication token validation,
        rate limiting, and request routing. Cold start times are consistently
        below one millisecond.
      </Text>

      <Text style={s.paragraph}>
        Rate limiting uses a sliding window algorithm backed by Cloudflare Durable
        Objects. Each user is allowed 1,000 requests per minute by default, with
        higher limits available on enterprise plans. When a limit is exceeded, the
        gateway returns a 429 response with a <Text style={s.bold}>Retry-After</Text> header.
      </Text>

      <Text style={s.paragraph}>
        A typical rate-limited response includes the following headers:
      </Text>

      <CodeBlock>{`HTTP/1.1 429 Too Many Requests
Content-Type: application/json
Retry-After: 12
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1719504000

{
  "error": "rate_limit_exceeded",
  "message": "Request limit of 1000/min exceeded. Retry after 12 seconds."
}`}</CodeBlock>

      <Text style={s.h2}>2.2 Core Services</Text>

      <Text style={s.paragraph}>
        The compute layer runs on Fly.io as a set of stateless Node.js
        processes. Auto-scaling is configured to maintain between 2 and 200
        instances depending on traffic. Each instance handles approximately 500
        concurrent connections before the scheduler provisions additional
        capacity.
      </Text>

      <Text style={s.paragraph}>
        Services communicate internally through a message bus built on Redis
        Streams. This decouples request handling from background processing such
        as webhook delivery, analytics aggregation, and search index updates.
      </Text>

      <Figure
        src={IMAGE_CODE}
        caption="Figure 2. Source code of the request routing module."
      />

      <Text style={s.h2}>2.3 Data Layer</Text>

      <Text style={s.paragraph}>
        The primary database is PostgreSQL 16, hosted on a managed cluster with
        one writer and two read replicas. Connection pooling is handled by
        PgBouncer in transaction mode. The application uses Prisma as the query
        interface, with raw SQL reserved for analytical queries.
      </Text>

      <Text style={s.paragraph}>
        A Redis cluster provides caching for session data, feature flags, and
        frequently accessed project metadata. Cache invalidation follows a
        write-through pattern: updates to PostgreSQL are followed by explicit
        cache deletes, and the next read populates the cache from the database.
      </Text>

      <Text style={s.paragraph}>
        Analytical data is stored in ClickHouse, which ingests approximately 2
        million events per hour. Dashboards and usage reports query ClickHouse
        directly, keeping analytical load off the primary database.
      </Text>

      <View style={s.hr} />

      <Text style={s.h1} minPresenceAhead={80}>3. Performance</Text>

      <Text style={s.paragraph}>
        The following observations are based on production metrics collected over
        the 30-day period ending June 15, 2026. All latency figures represent
        server-side processing time and do not include network transit.
      </Text>

      <Text style={s.h2}>3.1 Latency</Text>

      <Text style={s.paragraph}>
        Median response time across all API endpoints is 28 milliseconds. The
        95th percentile is 120 milliseconds, and the 99th percentile is 340
        milliseconds. The following table breaks down latency by endpoint.
      </Text>

      <View style={{ marginVertical: 12 }}>
        <TableRow cells={['Endpoint', 'P50 (ms)', 'P95 (ms)', 'P99 (ms)']} header />
        <TableRow cells={['/api/projects', '12', '38', '45']} />
        <TableRow cells={['/api/deploy', '89', '180', '210']} />
        <TableRow cells={['/api/analytics', '34', '95', '120']} />
        <TableRow cells={['/api/auth/login', '8', '18', '22']} />
        <TableRow cells={['/api/search', '156', '620', '890']} />
      </View>
      <Text style={s.tableCaption}>Table 1. API latency by endpoint over the 30-day measurement window.</Text>

      <Text style={s.paragraph}>
        The highest-latency endpoint is the full-text search API, which involves
        a round trip to the ClickHouse cluster.
      </Text>

      <Text style={s.h2}>3.2 Availability</Text>

      <Text style={s.paragraph}>
        Overall uptime for the quarter was 99.97%, with two incidents that caused
        partial degradation. The first was a PostgreSQL connection pool
        exhaustion event on April 12 that lasted 18 minutes. The second was an
        edge routing misconfiguration on May 3 that affected users in the
        Asia-Pacific region for 7 minutes. Both incidents triggered automated
        alerts and were resolved without data loss.
      </Text>

      <Text style={s.h2}>3.3 Key Improvements</Text>

      <Text style={s.paragraph}>
        Several changes during the quarter had a measurable impact on
        performance:
      </Text>

      <Bullet>
        Migrating the authentication service to edge workers reduced login
        latency from 180ms to 22ms at the median.
      </Bullet>
      <Bullet>
        Adding a read replica in Frankfurt cut European API latency by 40%.
      </Bullet>
      <Bullet>
        Switching the deployment pipeline from Docker builds to incremental file
        sync reduced deploy times from 90 seconds to 8 seconds.
      </Bullet>
      <Bullet>
        Enabling HTTP/3 on the CDN improved asset loading for users on
        high-latency mobile connections.
      </Bullet>

      <View style={s.hr} />

      <Text style={s.h1} minPresenceAhead={80}>4. Next Steps</Text>

      <Text style={s.paragraph}>
        The following work is planned for Q3 2026. Priorities may shift based on
        user feedback and operational needs.
      </Text>

      <Numbered n={1}>
        Introduce AI-assisted code review as a beta feature, using locally-hosted
        models to avoid sending source code to external services.
      </Numbered>
      <Numbered n={2}>
        Build a visual query builder for the analytics dashboard, replacing the
        current raw-SQL interface with a drag-and-drop editor.
      </Numbered>
      <Numbered n={3}>
        Release native mobile SDKs for iOS and Android, covering authentication,
        project management, and real-time event subscriptions.
      </Numbered>
      <Numbered n={4}>
        Migrate the Redis caching layer to a multi-region setup to reduce cache
        miss rates for users outside North America.
      </Numbered>
    </Page>
  </Document>
)

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------

const outputPath = `${process.cwd()}/example-output.pdf`

console.log('Generating PDF...')
await renderToFile(<Report />, outputPath)
console.log(`PDF saved to ${outputPath}`)
