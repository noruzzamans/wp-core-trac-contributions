const fetch = require('node-fetch');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// Configuration
const USERNAME = process.env.TRAC_USERNAME || 'noruzzaman';
const TRAC_BASE_URL = 'https://core.trac.wordpress.org';

// Paths
const ROOT_DIR = path.join(__dirname, '..');
const CONTRIBUTED_DIR = path.join(ROOT_DIR, 'contributed');
const MERGED_DIR = path.join(ROOT_DIR, 'merged');
const RELEASE_DIR = path.join(ROOT_DIR, '7.0-release');
const README_FILE = path.join(ROOT_DIR, 'README.md');

// Known ticket contributions (manually tracked + auto-discovered)
// This serves as a base - the script will also search for new ones
const KNOWN_TICKETS = [
    // Accessibility
    { id: 62982, comment: 6, type: 'test-report', component: 'Accessibility', title: 'Screen Reader elements lack text to describe their general function', focuses: 'accessibility', keywords: 'has-patch', milestone: '' },
    { id: 64065, comment: 6, type: 'patch-testing', component: 'Accessibility', title: 'Dragging theme/plugin ZIP outside file input field downloads file instead of uploading', focuses: 'accessibility', keywords: 'has-patch, needs-testing', milestone: '7.0' },
    { id: 63557, comment: 2, type: 'metadata', component: 'Accessibility', title: 'Add focus styles for skip links', focuses: 'accessibility', keywords: '', milestone: '' },

    // Block Editor
    { id: 63935, comment: 2, type: 'reproduction', component: 'Block Editor', title: 'Paragraph margins not honored in the backend with global styles', focuses: '', keywords: '', milestone: '' },
    { id: 43084, comment: 9, type: 'patch-testing', component: 'Block Editor', title: 'Media Library: Custom Taxonomy Bulk Edit support', focuses: '', keywords: 'has-patch', milestone: '' },
    { id: 62028, type: 'participation', component: 'Block Editor', title: 'Paragraph margins not honored in the backend when global styles set', focuses: '', keywords: '', milestone: '6.6.1' },

    // Bundled Themes
    { id: 64211, comment: 10, type: 'test-report', component: 'Bundled Themes', props: true, changeset: 61309, isMerged: true, title: 'Twenty Eleven: Improve PHP DocBlock compliance', focuses: 'coding-standards', keywords: 'has-patch', milestone: '6.8' },
    { id: 40557, type: 'participation', component: 'Bundled Themes', title: 'List Block indentation issue in Twenty Fifteen & Twenty Sixteen Themes (Editor Side)', focuses: '', keywords: 'dev-feedback', milestone: '' },
    { id: 61982, type: 'participation', component: 'Bundled Themes', title: 'Twenty Twenty-Five: The Written by pattern on single posts has too low color contrast in some variations', focuses: '', keywords: 'has-patch', milestone: '7.0' },
    { id: 62605, type: 'participation', component: 'Bundled Themes', title: 'Grid block background causes inconsistent padding on frontend', focuses: '', keywords: 'dev-feedback', milestone: '6.8.3' },

    // Coding Standards
    { id: 64262, type: 'participation', component: 'Coding Standards', title: 'Docblock improvements for 7.0', focuses: 'coding-standards', keywords: '', milestone: '7.0' },

    // General
    { id: 64324, type: 'participation', component: 'General', title: 'Outlined buttons now have grey background', focuses: '', keywords: 'has-patch', milestone: '6.9.1' },

    // Performance
    { id: 62697, type: 'participation', component: 'Site Health', title: 'Add OPCache to Site Health', focuses: 'performance', keywords: 'has-patch', milestone: '7.0' },
    { id: 64354, comment: 24, type: 'test-report', component: 'Performance', title: 'OPCache: Preloading WordPress PHP files', focuses: 'performance', keywords: 'has-patch, needs-testing', milestone: '7.0' },
    { id: 63697, comment: 24, type: 'test-report', component: 'Performance', title: 'Optimize CSS loading in admin', focuses: 'performance', keywords: 'has-patch', milestone: '' },

    // Posts, Post Types
    { id: 63091, type: 'participation', component: 'Posts, Post Types', title: 'Dashboard collapsing published posts count with alt-press', focuses: '', keywords: 'commit', milestone: '7.0' },

    // Upload/Media
    { id: 29798, type: 'participation', component: 'Upload/Media', title: 'Unified theme and plugin uploader', focuses: '', keywords: 'feature-request', milestone: '' },
];

// Date helpers
const formatDate = (dateStr) => {
    const date = new Date(dateStr);
    const months = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];
    return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
};

const getMonthYear = (dateStr) => {
    const date = new Date(dateStr);
    const months = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];
    return { month: months[date.getMonth()], year: date.getFullYear() };
};

// Fetch ticket details from Trac
async function fetchTicketDetails(ticketId) {
    try {
        const url = `${TRAC_BASE_URL}/ticket/${ticketId}`;
        const response = await fetch(url);
        const html = await response.text();
        const $ = cheerio.load(html);

        // Extract ticket info
        const title = $('h1.searchable').text().trim() || $('title').text().split('–')[0].trim();
        const status = $('.trac-status a').text().trim() || 'unknown';
        const resolution = $('.trac-resolution').text().trim() || '';
        const component = $('td[headers="h_component"]').text().trim() || 'General';
        const milestone = $('td[headers="h_milestone"]').text().trim() || '';

        // Extract Focuses and Keywords
        const focuses = $('td[headers="h_focuses"]').text().trim() || '';
        const keywords = $('td[headers="h_keywords"]').text().trim() || '';

        // Check if merged (has a changeset)
        const isMerged = resolution.includes('fixed') || status === 'closed';
        let changesetId = null;
        let mergedDate = null;

        // Look for changeset in comments
        const changesetMatch = html.match(/changeset\/(\d+)/);
        if (changesetMatch) {
            changesetId = changesetMatch[1];
        }

        return {
            id: ticketId,
            title: title.replace(/^#\d+\s*/, '').replace(/\s*\(.*\)$/, ''),
            status,
            resolution,
            component,
            milestone,
            focuses,
            keywords,
            isMerged,
            changesetId,
            mergedDate,
            url
        };
    } catch (error) {
        console.error(`Error fetching ticket #${ticketId}:`, error.message);
        return null;
    }
}

// Check if user received props in a changeset
async function checkPropsInChangeset(changesetId) {
    if (!changesetId) return false;

    try {
        const url = `${TRAC_BASE_URL}/changeset/${changesetId}`;
        const response = await fetch(url);
        const html = await response.text();

        // Check if username is mentioned in props
        const hasProps = html.toLowerCase().includes(USERNAME.toLowerCase());
        return hasProps;
    } catch (error) {
        console.error(`Error checking changeset ${changesetId}:`, error.message);
        return false;
    }
}

// Search Trac for user contributions
async function searchUserContributions() {
    console.log('📥 Searching for user contributions on Trac...');
    const contributions = [];

    try {
        // Search for mentions of username
        const searchUrl = `${TRAC_BASE_URL}/search?q=${USERNAME}&noquickjump=1&changeset=on&ticket=on`;
        const response = await fetch(searchUrl);
        const html = await response.text();
        const $ = cheerio.load(html);

        // Extract ticket mentions from search results
        $('dt a').each((i, el) => {
            const href = $(el).attr('href');
            const text = $(el).text();

            if (href && href.includes('/ticket/')) {
                const match = href.match(/\/ticket\/(\d+)/);
                if (match) {
                    const ticketId = parseInt(match[1]);
                    // Check if not already in known tickets
                    if (!KNOWN_TICKETS.find(t => t.id === ticketId)) {
                        contributions.push({
                            id: ticketId,
                            title: text,
                            type: 'participation',
                            discovered: true
                        });
                    }
                }
            }
        });

        console.log(`   Found ${contributions.length} additional tickets from search`);
    } catch (error) {
        console.error('Error searching Trac:', error.message);
    }

    return contributions;
}

// Process all tickets and gather full details
async function processAllTickets() {
    console.log('📥 Processing all tickets...');

    // Combine known tickets with discovered ones
    const discoveredTickets = await searchUserContributions();
    const allTicketConfigs = [...KNOWN_TICKETS, ...discoveredTickets];

    const tickets = [];

    for (const config of allTicketConfigs) {
        console.log(`   Fetching details for ticket #${config.id}...`);
        const details = await fetchTicketDetails(config.id);

        if (details) {
            // Merge config with fetched details
            const ticket = {
                ...details,
                type: config.type || 'participation',
                contributionType: config.type || 'participation',
                comment: config.comment,
                component: config.component || details.component,
                hasProps: config.props || false,
                changeset: config.changeset || details.changesetId,
                // Use config title as fallback if fetched title shows 403 or is empty
                title: (details.title && !details.title.includes('403') && !details.title.includes('Forbidden'))
                    ? details.title
                    : (config.title || `Ticket #${config.id}`),
                // Use config isMerged as fallback
                isMerged: details.isMerged || config.isMerged || false,
                // Focuses, Keywords, Milestone with fallbacks
                focuses: details.focuses || config.focuses || '',
                keywords: details.keywords || config.keywords || '',
                milestone: details.milestone || config.milestone || ''
            };

            // Check props if we have a changeset
            if (ticket.changeset && !ticket.hasProps) {
                ticket.hasProps = await checkPropsInChangeset(ticket.changeset);
            }

            tickets.push(ticket);
        }

        // Rate limiting - be nice to Trac server
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(`   Processed ${tickets.length} tickets total`);
    console.log(`   - With Props: ${tickets.filter(t => t.hasProps).length}`);
    console.log(`   - Merged: ${tickets.filter(t => t.isMerged).length}`);

    return tickets;
}

// Get contribution type label
function getTypeLabel(type) {
    const labels = {
        'test-report': '🧪 Test Report',
        'patch-testing': '🔧 Patch Testing',
        'reproduction': '🔍 Reproduction Report',
        'metadata': '📝 Metadata Updates',
        'participation': '💬 Participation',
        'comment': '💬 Comment'
    };
    return labels[type] || '💬 Participation';
}

// Generate contributed/tickets.md
function generateContributedTickets(tickets) {
    // Group by component
    const byComponent = {};
    for (const ticket of tickets) {
        const comp = ticket.component || 'General';
        if (!byComponent[comp]) byComponent[comp] = [];
        byComponent[comp].push(ticket);
    }

    let content = `# My Contributed Tickets (2025-2026)

<!-- AUTO-SYNC START - DO NOT EDIT BELOW THIS LINE -->
<!-- Last synced: ${new Date().toISOString()} -->

`;

    const components = Object.keys(byComponent).sort();

    for (const component of components) {
        content += `## ${component}\n`;
        for (const ticket of byComponent[component]) {
            const propsIcon = ticket.hasProps ? ' ✅' : '';
            const typeLabel = getTypeLabel(ticket.type);
            const commentLink = ticket.comment ? `#comment:${ticket.comment}` : '';
            content += `- [#${ticket.id}](${TRAC_BASE_URL}/ticket/${ticket.id}${commentLink}) - ${ticket.title}\n`;
            content += `  - **Type**: ${typeLabel}${propsIcon}\n`;
            if (ticket.milestone) {
                content += `  - **Milestone**: ${ticket.milestone}\n`;
            }
            if (ticket.focuses) {
                content += `  - **Focuses**: ${ticket.focuses}\n`;
            }
            if (ticket.keywords) {
                content += `  - **Keywords**: ${ticket.keywords}\n`;
            }
            content += `\n`;
        }
    }

    const withProps = tickets.filter(t => t.hasProps).length;
    const merged = tickets.filter(t => t.isMerged).length;

    content += `<!-- AUTO-SYNC END -->

---
## Summary
| Category | Count |
|----------|-------|
| ✅ With Props | ${withProps} |
| 🔄 Merged | ${merged} |
| **Total** | **${tickets.length}** |
`;

    return content;
}

// Generate contributed/test-reports.md (includes patch testing)
function generateTestReports(tickets) {
    const testReports = tickets.filter(t => t.type === 'test-report');
    const patchTests = tickets.filter(t => t.type === 'patch-testing');
    const allTests = [...testReports, ...patchTests];

    let content = `# Test Reports & Patch Testing

All testing contributions - test reports and patch testing.

<!-- AUTO-SYNC START - DO NOT EDIT BELOW THIS LINE -->
<!-- Last synced: ${new Date().toISOString()} -->

`;

    if (allTests.length === 0) {
        content += `*No test contributions yet*\n\n`;
    } else {
        // Test Reports section
        if (testReports.length > 0) {
            content += `## 🧪 Test Reports\n\n`;
            for (const ticket of testReports) {
                const propsIcon = ticket.hasProps ? '✅' : '⏳';
                const commentLink = ticket.comment ? `#comment:${ticket.comment}` : '';
                content += `- ${propsIcon} [#${ticket.id}](${TRAC_BASE_URL}/ticket/${ticket.id}${commentLink}) - ${ticket.title}\n`;
                content += `  - **Component**: ${ticket.component}\n`;
                if (ticket.milestone) content += `  - **Milestone**: ${ticket.milestone}\n`;
                if (ticket.focuses) content += `  - **Focuses**: ${ticket.focuses}\n`;
                if (ticket.keywords) content += `  - **Keywords**: ${ticket.keywords}\n`;
                content += `\n`;
            }
        }

        // Patch Testing section
        if (patchTests.length > 0) {
            content += `## 🔧 Patch Testing\n\n`;
            for (const ticket of patchTests) {
                const propsIcon = ticket.hasProps ? '✅' : '⏳';
                const commentLink = ticket.comment ? `#comment:${ticket.comment}` : '';
                content += `- ${propsIcon} [#${ticket.id}](${TRAC_BASE_URL}/ticket/${ticket.id}${commentLink}) - ${ticket.title}\n`;
                content += `  - **Component**: ${ticket.component}\n`;
                if (ticket.milestone) content += `  - **Milestone**: ${ticket.milestone}\n`;
                if (ticket.focuses) content += `  - **Focuses**: ${ticket.focuses}\n`;
                if (ticket.keywords) content += `  - **Keywords**: ${ticket.keywords}\n`;
                content += `\n`;
            }
        }
    }

    content += `<!-- AUTO-SYNC END -->

---
## Summary
| Type | Count |
|------|-------|
| 🧪 Test Reports | ${testReports.length} |
| 🔧 Patch Testing | ${patchTests.length} |
| **Total** | **${allTests.length}** |
`;

    return content;
}

// Generate contributed/patch-testing.md
function generatePatchTesting(tickets) {
    const patchTests = tickets.filter(t => t.type === 'patch-testing');

    let content = `# Patch Testing

Patches I tested on Trac tickets.

<!-- AUTO-SYNC START - DO NOT EDIT BELOW THIS LINE -->
<!-- Last synced: ${new Date().toISOString()} -->

`;

    if (patchTests.length === 0) {
        content += `*No patch testing yet*\n\n`;
    } else {
        for (const ticket of patchTests) {
            const propsIcon = ticket.hasProps ? '✅' : '⏳';
            const commentLink = ticket.comment ? `#comment:${ticket.comment}` : '';
            content += `- ${propsIcon} [#${ticket.id}](${TRAC_BASE_URL}/ticket/${ticket.id}${commentLink}) - ${ticket.title}\n`;
            content += `  - **Component**: ${ticket.component}\n`;
            content += `\n`;
        }
    }

    content += `<!-- AUTO-SYNC END -->

---
**Total Patch Tests**: ${patchTests.length}
`;

    return content;
}

// Generate contributed/with-props.md
function generateWithProps(tickets) {
    const withProps = tickets.filter(t => t.hasProps);

    let content = `# Props Received

Tickets where I received props in the changeset.

<!-- AUTO-SYNC START - DO NOT EDIT BELOW THIS LINE -->
<!-- Last synced: ${new Date().toISOString()} -->

`;

    if (withProps.length === 0) {
        content += `*No props received yet*\n\n`;
    } else {
        for (const ticket of withProps) {
            const typeLabel = getTypeLabel(ticket.type);
            content += `- ✅ [#${ticket.id}](${TRAC_BASE_URL}/ticket/${ticket.id}) - ${ticket.title}\n`;
            content += `  - **Contribution**: ${typeLabel}\n`;
            content += `  - **Component**: ${ticket.component}\n`;
            if (ticket.changeset) {
                content += `  - **Changeset**: [${ticket.changeset}](${TRAC_BASE_URL}/changeset/${ticket.changeset})\n`;
            }
            content += `\n`;
        }
    }

    content += `<!-- AUTO-SYNC END -->

---
**Total Props Received**: ${withProps.length}
`;

    return content;
}

// Generate contributed/without-props.md
function generateWithoutProps(tickets) {
    const withoutProps = tickets.filter(t => !t.hasProps);

    let content = `# No Props Yet

Tickets where I contributed but haven't received props yet.

<!-- AUTO-SYNC START - DO NOT EDIT BELOW THIS LINE -->
<!-- Last synced: ${new Date().toISOString()} -->

`;

    if (withoutProps.length === 0) {
        content += `*All contributions have received props!*\n\n`;
    } else {
        const open = withoutProps.filter(t => !t.isMerged);
        const merged = withoutProps.filter(t => t.isMerged);

        if (open.length > 0) {
            content += `## ⏳ Open/Pending\n\n`;
            for (const ticket of open) {
                const typeLabel = getTypeLabel(ticket.type);
                content += `- ⏳ [#${ticket.id}](${TRAC_BASE_URL}/ticket/${ticket.id}) - ${ticket.title}\n`;
                content += `  - **Contribution**: ${typeLabel}\n`;
                content += `  - **Component**: ${ticket.component}\n`;
                content += `\n`;
            }
        }

        if (merged.length > 0) {
            content += `## 🤔 Merged (No Props)\n\n`;
            for (const ticket of merged) {
                const typeLabel = getTypeLabel(ticket.type);
                content += `- 🤔 [#${ticket.id}](${TRAC_BASE_URL}/ticket/${ticket.id}) - ${ticket.title}\n`;
                content += `  - **Contribution**: ${typeLabel}\n`;
                content += `  - **Component**: ${ticket.component}\n`;
                content += `\n`;
            }
        }
    }

    content += `<!-- AUTO-SYNC END -->

---
**Total Without Props**: ${withoutProps.length}
`;

    return content;
}

// Generate merged/tickets.md
function generateMergedTickets(tickets) {
    const merged = tickets.filter(t => t.hasProps && t.isMerged);

    // Group by year then month (use current date as approximation)
    const byYear = {};
    for (const ticket of merged) {
        const year = 2025; // Most contributions are from 2025
        const month = 'November'; // Approximation
        if (!byYear[year]) byYear[year] = {};
        if (!byYear[year][month]) byYear[year][month] = [];
        byYear[year][month].push(ticket);
    }

    let content = `# Merged Tickets

Tickets merged into WordPress Core where I received props.

<!-- AUTO-SYNC START - DO NOT EDIT BELOW THIS LINE -->
<!-- Last synced: ${new Date().toISOString()} -->

`;

    if (merged.length === 0) {
        content += `*No merged tickets with props yet*\n\n`;
    } else {
        const years = Object.keys(byYear).sort((a, b) => b - a);
        for (const year of years) {
            content += `## ${year}\n\n`;
            const months = Object.keys(byYear[year]);
            for (const month of months) {
                content += `### ${month}\n`;
                for (const ticket of byYear[year][month]) {
                    const typeLabel = getTypeLabel(ticket.type);
                    content += `- ✅ [#${ticket.id}](${TRAC_BASE_URL}/ticket/${ticket.id}) - ${ticket.title}\n`;
                    if (ticket.changeset) {
                        content += `  - **Changeset**: [${ticket.changeset}](${TRAC_BASE_URL}/changeset/${ticket.changeset})\n`;
                    }
                    content += `  - **Contribution**: ${typeLabel}\n`;
                    content += `\n`;
                }
            }
        }
    }

    content += `<!-- AUTO-SYNC END -->

---
**Total Merged with Props**: ${merged.length}
`;

    return content;
}

// Generate 7.0-release/tickets.md
function generate7ReleaseTickets(tickets) {
    const releaseTickets = tickets.filter(t => t.milestone && t.milestone.includes('7.0'));

    let content = `# WordPress 7.0 Release Contributions

My contributions targeting WordPress 7.0 release.

<!-- AUTO-SYNC START - DO NOT EDIT BELOW THIS LINE -->
<!-- Last synced: ${new Date().toISOString()} -->

`;

    if (releaseTickets.length === 0) {
        content += `*No 7.0 milestone tickets yet*\n\n`;
    } else {
        // Group by component
        const byComponent = {};
        for (const ticket of releaseTickets) {
            const comp = ticket.component || 'General';
            if (!byComponent[comp]) byComponent[comp] = [];
            byComponent[comp].push(ticket);
        }

        for (const component of Object.keys(byComponent).sort()) {
            content += `## ${component}\n\n`;
            for (const ticket of byComponent[component]) {
                const propsIcon = ticket.hasProps ? '✅' : '⏳';
                const typeLabel = getTypeLabel(ticket.type);
                const commentLink = ticket.comment ? `#comment:${ticket.comment}` : '';
                content += `### ${propsIcon} [#${ticket.id}](${TRAC_BASE_URL}/ticket/${ticket.id}${commentLink})\n`;
                content += `**${ticket.title}**\n\n`;
                content += `| Field | Value |\n`;
                content += `|-------|-------|\n`;
                content += `| Type | ${typeLabel} |\n`;
                content += `| Component | ${ticket.component} |\n`;
                content += `| Milestone | ${ticket.milestone} |\n`;
                if (ticket.focuses) content += `| Focuses | ${ticket.focuses} |\n`;
                if (ticket.keywords) content += `| Keywords | ${ticket.keywords} |\n`;
                content += `| Props | ${ticket.hasProps ? '✅ Received' : '⏳ Pending'} |\n`;
                content += `\n`;
            }
        }
    }

    const withProps = releaseTickets.filter(t => t.hasProps).length;
    const pending = releaseTickets.filter(t => !t.hasProps).length;

    content += `<!-- AUTO-SYNC END -->

---
## Summary
| Status | Count |
|--------|-------|
| ✅ Props Received | ${withProps} |
| ⏳ Pending | ${pending} |
| **Total 7.0 Tickets** | **${releaseTickets.length}** |
`;

    return content;
}

// Update README with stats
function updateReadme(tickets) {
    const total = tickets.length;
    const withProps = tickets.filter(t => t.hasProps).length;
    const merged = tickets.filter(t => t.isMerged).length;
    const testReports = tickets.filter(t => t.type === 'test-report').length;
    const patchTesting = tickets.filter(t => t.type === 'patch-testing').length;
    const open = tickets.filter(t => !t.isMerged).length;
    const propsRate = total > 0 ? Math.round((withProps / total) * 100) : 0;
    const release70 = tickets.filter(t => t.milestone && t.milestone.includes('7.0')).length;

    // Count by component
    const byComponent = {};
    for (const ticket of tickets) {
        const comp = ticket.component || 'General';
        byComponent[comp] = (byComponent[comp] || 0) + 1;
    }

    const today = new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });

    const content = `# WordPress Core Trac Contributions

Personal tracking for WordPress Core Trac contributions.

## Quick Navigation

### 📊 Contributions
- 📝 [All Tickets](./contributed/tickets.md) - All my contributions
- 🧪 [Test Reports & Patch Testing](./contributed/test-reports.md) - Testing contributions
- ✅ [Props Received](./contributed/with-props.md) - Tickets with props
- ⏳ [No Props Yet](./contributed/without-props.md) - Waiting for props

### ✅ Merged
- 🎉 [Merged Tickets](./merged/tickets.md) - Merged into Core

### 🚀 7.0 Release
- 🎯 [7.0 Release Tickets](./7.0-release/tickets.md) - **${release70}** tickets targeted for WordPress 7.0

### 🎯 Goals
- [2026 Goals](./next-targets/2026-goals.md) - Contribution targets
- 👤 [About Me](./about-me.md) - Profile & expertise

## 📈 Stats (Auto-Updated)


<table width="100%" style="width: 100% !important;">
<tr>
<td width="33.33%" align="center" valign="top"><b>📊 Contributions</b></td>
<td width="33.33%" align="center" valign="top"><b>📁 By Type</b></td>
<td width="33.34%" align="center" valign="top"><b>🎯 Highlights</b></td>
</tr>
<tr>
<td width="33.33%" valign="top">

| Metric | Count |
|:-------|------:|
| [📝 Total](./contributed/tickets.md) | ${total} |
| [✅ Props](./contributed/with-props.md) | ${withProps} |
| [🔄 Merged](./merged/tickets.md) | ${merged} |
| [⏳ Pending](./contributed/without-props.md) | ${open} |

</td>
<td width="33.33%" valign="top">

| Type | Count |
|:-------|------:|
| [🧪 Test Reports](./contributed/test-reports.md) | ${testReports} |
| [🔧 Patch Testing](./contributed/test-reports.md) | ${patchTesting} |
| 💬 Other | ${total - testReports - patchTesting} |

</td>
<td width="33.34%" valign="top">

| Metric | Value |
|:-------|:------|
| 📈 Props Rate | **${propsRate}%** |
| 🎉 Total | **${total}** tickets |
| 🔥 Merged | **${merged}** into Core |
| ⭐ Success | **${withProps}** props |

</td>
</tr>
</table>

---
**Last Synced**: ${today}
`;

    return content;
}

// Main sync function
async function main() {
    console.log('🚀 Starting WordPress Core Trac sync...\n');

    // Ensure directories exist
    if (!fs.existsSync(CONTRIBUTED_DIR)) {
        fs.mkdirSync(CONTRIBUTED_DIR, { recursive: true });
    }
    if (!fs.existsSync(MERGED_DIR)) {
        fs.mkdirSync(MERGED_DIR, { recursive: true });
    }
    if (!fs.existsSync(RELEASE_DIR)) {
        fs.mkdirSync(RELEASE_DIR, { recursive: true });
    }

    // Process all tickets
    const tickets = await processAllTickets();

    console.log('\n📝 Generating markdown files...');

    // Generate and write all files
    fs.writeFileSync(
        path.join(CONTRIBUTED_DIR, 'tickets.md'),
        generateContributedTickets(tickets)
    );
    console.log('   ✅ contributed/tickets.md');

    fs.writeFileSync(
        path.join(CONTRIBUTED_DIR, 'test-reports.md'),
        generateTestReports(tickets)
    );
    console.log('   ✅ contributed/test-reports.md');

    fs.writeFileSync(
        path.join(CONTRIBUTED_DIR, 'with-props.md'),
        generateWithProps(tickets)
    );
    console.log('   ✅ contributed/with-props.md');

    fs.writeFileSync(
        path.join(CONTRIBUTED_DIR, 'without-props.md'),
        generateWithoutProps(tickets)
    );
    console.log('   ✅ contributed/without-props.md');

    fs.writeFileSync(
        path.join(MERGED_DIR, 'tickets.md'),
        generateMergedTickets(tickets)
    );
    console.log('   ✅ merged/tickets.md');

    // Generate 7.0 release files
    fs.writeFileSync(
        path.join(RELEASE_DIR, 'tickets.md'),
        generate7ReleaseTickets(tickets)
    );
    console.log('   ✅ 7.0-release/tickets.md');

    fs.writeFileSync(README_FILE, updateReadme(tickets));
    console.log('   ✅ README.md');

    console.log('\n✅ Sync complete!');
    console.log(`   Total tickets: ${tickets.length}`);
    console.log(`   With props: ${tickets.filter(t => t.hasProps).length}`);
    console.log(`   Merged: ${tickets.filter(t => t.isMerged).length}`);
}

main().catch(console.error);
