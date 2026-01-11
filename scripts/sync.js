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

// Date helpers
const formatDate = (dateStr) => {
    if (!dateStr) return 'Unknown';
    const date = new Date(dateStr);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
};

// Auto-discover ALL tickets user commented on
async function fetchUserTicketsFromTrac() {
    console.log(`🔍 Fetching ALL tickets for user: ${USERNAME}...`);

    const allTickets = [];

    // Fetch tickets where user commented (up to 200)
    const queryUrl = `${TRAC_BASE_URL}/query?comment=~${USERNAME}&col=id&col=summary&col=component&col=status&col=type&col=milestone&order=changetime&desc=1&max=200`;

    try {
        const response = await fetch(queryUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        if (!response.ok) throw new Error(`Trac query failed: ${response.status}`);

        const html = await response.text();
        const $ = cheerio.load(html);

        // Parse the query result table
        $('table.tickets tbody tr').each((i, row) => {
            const $row = $(row);
            const idLink = $row.find('td.id a');
            const summaryLink = $row.find('td.summary a');
            const component = $row.find('td.component').text().trim();
            const status = $row.find('td.status').text().trim();
            const type = $row.find('td.type').text().trim();
            const milestone = $row.find('td.milestone').text().trim();

            if (idLink.length) {
                const href = idLink.attr('href');
                const id = parseInt(href.split('/').pop().split('#')[0]);

                if (id && !isNaN(id)) {
                    allTickets.push({
                        id,
                        title: summaryLink.text().trim() || `Ticket #${id}`,
                        component: component || 'General',
                        status: status || 'unknown',
                        type: type || 'defect',
                        milestone: milestone || ''
                    });
                }
            }
        });

        console.log(`   Found ${allTickets.length} tickets from Trac query`);
    } catch (error) {
        console.error('   ❌ Query failed:', error.message);
    }

    return allTickets;
}

// Fetch detailed ticket info including user's actual comments
async function fetchTicketDetails(ticketId) {
    try {
        const url = `${TRAC_BASE_URL}/ticket/${ticketId}`;
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        if (!response.ok) return null;

        const html = await response.text();
        const $ = cheerio.load(html);

        // Basic ticket info
        const title = $('h2.summary').text().trim() ||
            $('h1.searchable').text().trim() ||
            `Ticket #${ticketId}`;
        const status = $('span.trac-status a').text().trim() || 'unknown';
        const resolution = $('span.trac-resolution').text().trim() || '';
        const component = $('td[headers="h_component"]').text().trim() || 'General';
        const milestone = $('td[headers="h_milestone"]').text().trim() || '';
        const focuses = $('td[headers="h_focuses"]').text().trim() || '';
        const keywords = $('td[headers="h_keywords"]').text().trim() || '';
        const reporter = $('td[headers="h_reporter"]').text().trim() || '';

        // Check if user is the reporter
        const isReporter = reporter.toLowerCase() === USERNAME.toLowerCase();

        // Find ALL user's comments
        const userComments = [];
        $('div.change').each((i, el) => {
            const $change = $(el);
            const author = $change.find('h3.change a.author').text().trim();

            if (author.toLowerCase() === USERNAME.toLowerCase()) {
                const commentText = $change.find('div.comment').text().trim();
                const commentDate = $change.find('h3.change a.timeline').attr('title') || '';

                userComments.push({
                    text: commentText,
                    date: commentDate
                });
            }
        });

        // Determine contribution type from comments
        let contributionType = 'comment';
        const allCommentText = userComments.map(c => c.text).join(' ').toLowerCase();

        if (allCommentText.includes('tested') ||
            allCommentText.includes('testing') ||
            allCommentText.includes('test report') ||
            allCommentText.includes('confirmed') ||
            allCommentText.includes('can confirm') ||
            allCommentText.includes('verified') ||
            allCommentText.includes('works as expected') ||
            allCommentText.includes('reproduced')) {
            contributionType = 'test-report';
        } else if (allCommentText.includes('patch') ||
            allCommentText.includes('applied') ||
            allCommentText.includes('diff') ||
            allCommentText.includes('fix uploaded')) {
            contributionType = 'patch';
        } else if (allCommentText.includes('review') ||
            allCommentText.includes('code looks')) {
            contributionType = 'code-review';
        }

        // Check if closed/merged
        const isClosed = status === 'closed';
        const isFixed = resolution.toLowerCase().includes('fixed');

        // Find changesets
        const changesets = [];
        $('a[href*="/changeset/"]').each((i, el) => {
            const href = $(el).attr('href');
            const match = href.match(/changeset\/(\d+)/);
            if (match) {
                changesets.push(match[1]);
            }
        });

        // Check props in changesets
        let hasProps = false;
        let propsChangeset = null;

        for (const changesetId of changesets.slice(0, 3)) { // Check first 3 changesets
            try {
                const csUrl = `${TRAC_BASE_URL}/changeset/${changesetId}`;
                const csResponse = await fetch(csUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0' }
                });
                const csHtml = await csResponse.text();

                if (csHtml.toLowerCase().includes(USERNAME.toLowerCase())) {
                    hasProps = true;
                    propsChangeset = changesetId;
                    break;
                }
            } catch (e) {
                // Ignore changeset check errors
            }
        }

        return {
            id: ticketId,
            title: title.replace(/^#\d+\s*/, '').replace(/\(.*\)$/, '').trim(),
            status,
            resolution,
            component,
            milestone,
            focuses,
            keywords,
            reporter,
            isReporter,
            contributionType,
            userComments,
            commentCount: userComments.length,
            isClosed,
            isFixed,
            isMerged: isClosed && isFixed,
            hasProps,
            propsChangeset,
            changesets,
            url
        };
    } catch (error) {
        console.error(`   ❌ Error fetching #${ticketId}:`, error.message);
        return null;
    }
}

// Process all tickets
async function processAllTickets() {
    console.log('📥 Processing all tickets...\n');

    // Fetch all tickets from Trac
    const ticketList = await fetchUserTicketsFromTrac();

    if (ticketList.length === 0) {
        console.log('   No tickets found!');
        return [];
    }

    const tickets = [];
    let processed = 0;

    for (const basic of ticketList) {
        processed++;
        console.log(`   [${processed}/${ticketList.length}] Fetching #${basic.id}...`);

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));

        const details = await fetchTicketDetails(basic.id);

        if (details) {
            // Merge basic info with details
            tickets.push({
                ...details,
                component: details.component || basic.component,
                milestone: details.milestone || basic.milestone,
                type: basic.type
            });
        }
    }

    // Sort by ID descending
    tickets.sort((a, b) => b.id - a.id);

    console.log(`\n✅ Processed ${tickets.length} tickets`);
    console.log(`   - With Props: ${tickets.filter(t => t.hasProps).length}`);
    console.log(`   - Merged: ${tickets.filter(t => t.isMerged).length}`);
    console.log(`   - Test Reports: ${tickets.filter(t => t.contributionType === 'test-report').length}`);

    return tickets;
}

// Get contribution type label
function getTypeLabel(type) {
    const labels = {
        'test-report': '🧪 Test Report',
        'patch': '📝 Patch',
        'code-review': '👀 Code Review',
        'comment': '💬 Comment'
    };
    return labels[type] || '💬 Comment';
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

    let content = `# All My Trac Contributions

Total **${tickets.length}** tickets where I participated.

<!-- AUTO-SYNC - DO NOT EDIT -->

`;

    const components = Object.keys(byComponent).sort();

    for (const component of components) {
        content += `## ${component}\n\n`;

        for (const ticket of byComponent[component]) {
            const propsIcon = ticket.hasProps ? '✅' : (ticket.isMerged ? '❌' : '⏳');
            const statusIcon = ticket.isMerged ? '🔒' : '🔓';
            const typeLabel = getTypeLabel(ticket.contributionType);

            content += `### ${statusIcon} [#${ticket.id}](${TRAC_BASE_URL}/ticket/${ticket.id})\n`;
            content += `**${ticket.title}**\n\n`;
            content += `| Field | Value |\n`;
            content += `|-------|-------|\n`;
            content += `| Contribution | ${typeLabel} |\n`;
            content += `| Props | ${propsIcon} ${ticket.hasProps ? 'Received' : (ticket.isMerged ? 'Not Given' : 'Pending')} |\n`;
            content += `| Status | ${ticket.status}${ticket.resolution ? ` (${ticket.resolution})` : ''} |\n`;
            if (ticket.milestone) content += `| Milestone | ${ticket.milestone} |\n`;
            if (ticket.commentCount) content += `| My Comments | ${ticket.commentCount} |\n`;
            content += `\n`;
        }
    }

    // Summary
    const withProps = tickets.filter(t => t.hasProps).length;
    const merged = tickets.filter(t => t.isMerged).length;
    const testReports = tickets.filter(t => t.contributionType === 'test-report').length;
    const patches = tickets.filter(t => t.contributionType === 'patch').length;

    content += `---
## 📊 Summary

| Category | Count |
|----------|------:|
| 📝 Total Tickets | ${tickets.length} |
| ✅ Props Received | ${withProps} |
| 🔒 Merged/Fixed | ${merged} |
| 🧪 Test Reports | ${testReports} |
| 📝 Patches | ${patches} |
`;

    return content;
}

// Generate contributed/test-reports.md
function generateTestReports(tickets) {
    const testReports = tickets.filter(t => t.contributionType === 'test-report');

    let content = `# My Test Reports

All tickets where I provided testing contributions.

<!-- AUTO-SYNC - DO NOT EDIT -->

`;

    if (testReports.length === 0) {
        content += `*No test reports yet*\n\n`;
    } else {
        // Group by props status
        const withProps = testReports.filter(t => t.hasProps);
        const merged = testReports.filter(t => t.isMerged && !t.hasProps);
        const pending = testReports.filter(t => !t.isMerged);

        if (withProps.length > 0) {
            content += `## ✅ Props Received (${withProps.length})\n\n`;
            for (const t of withProps) {
                content += `- ✅ [#${t.id}](${TRAC_BASE_URL}/ticket/${t.id}) - ${t.title}\n`;
                content += `  - **Component**: ${t.component}${t.milestone ? ` | **Milestone**: ${t.milestone}` : ''}\n\n`;
            }
        }

        if (merged.length > 0) {
            content += `## ❌ Merged Without Props (${merged.length})\n\n`;
            for (const t of merged) {
                content += `- ❌ [#${t.id}](${TRAC_BASE_URL}/ticket/${t.id}) - ${t.title}\n`;
                content += `  - **Component**: ${t.component}${t.milestone ? ` | **Milestone**: ${t.milestone}` : ''}\n\n`;
            }
        }

        if (pending.length > 0) {
            content += `## ⏳ Pending (${pending.length})\n\n`;
            for (const t of pending) {
                content += `- ⏳ [#${t.id}](${TRAC_BASE_URL}/ticket/${t.id}) - ${t.title}\n`;
                content += `  - **Component**: ${t.component} | **Status**: ${t.status}\n\n`;
            }
        }
    }

    content += `---
**Total Test Reports**: ${testReports.length}
`;

    return content;
}

// Generate contributed/with-props.md
function generateWithProps(tickets) {
    const withProps = tickets.filter(t => t.hasProps);

    let content = `# ✅ Props Received

Tickets where I contributed and received props in the changeset.

<!-- AUTO-SYNC - DO NOT EDIT -->

`;

    if (withProps.length === 0) {
        content += `*No props received yet - keep contributing!*\n\n`;
    } else {
        for (const t of withProps) {
            const typeLabel = getTypeLabel(t.contributionType);
            content += `- ✅ [#${t.id}](${TRAC_BASE_URL}/ticket/${t.id}) - ${t.title}\n`;
            content += `  - **Contribution**: ${typeLabel}\n`;
            content += `  - **Component**: ${t.component}\n`;
            if (t.propsChangeset) {
                content += `  - **Changeset**: [${t.propsChangeset}](${TRAC_BASE_URL}/changeset/${t.propsChangeset})\n`;
            }
            content += `\n`;
        }
    }

    content += `---
**Total Props Received**: ${withProps.length}
`;

    return content;
}

// Generate contributed/without-props.md
function generateWithoutProps(tickets) {
    // No props: either pending or merged without props
    const pending = tickets.filter(t => !t.hasProps && !t.isMerged);
    const mergedNoProps = tickets.filter(t => !t.hasProps && t.isMerged);

    let content = `# No Props Yet

Tickets where I contributed but haven't received props.

<!-- AUTO-SYNC - DO NOT EDIT -->

`;

    if (pending.length > 0) {
        content += `## ⏳ Pending (${pending.length})\n\nThese are still open - will get props once merged!\n\n`;
        for (const t of pending) {
            const typeLabel = getTypeLabel(t.contributionType);
            content += `- ⏳ [#${t.id}](${TRAC_BASE_URL}/ticket/${t.id}) - ${t.title}\n`;
            content += `  - ${typeLabel} | ${t.component} | ${t.status}\n\n`;
        }
    }

    if (mergedNoProps.length > 0) {
        content += `## ❌ Merged Without Props (${mergedNoProps.length})\n\nThese were merged but I didn't get props.\n\n`;
        for (const t of mergedNoProps) {
            const typeLabel = getTypeLabel(t.contributionType);
            content += `- ❌ [#${t.id}](${TRAC_BASE_URL}/ticket/${t.id}) - ${t.title}\n`;
            content += `  - ${typeLabel} | ${t.component}\n\n`;
        }
    }

    if (pending.length === 0 && mergedNoProps.length === 0) {
        content += `*All contributions have received props! 🎉*\n\n`;
    }

    content += `---
| Status | Count |
|--------|------:|
| ⏳ Pending | ${pending.length} |
| ❌ Merged (No Props) | ${mergedNoProps.length} |
`;

    return content;
}

// Generate merged/tickets.md
function generateMergedTickets(tickets) {
    const merged = tickets.filter(t => t.isMerged);

    let content = `# Merged Tickets

Tickets that have been merged/fixed in WordPress Core.

<!-- AUTO-SYNC - DO NOT EDIT -->

`;

    if (merged.length === 0) {
        content += `*No merged tickets yet*\n\n`;
    } else {
        // Split by props
        const withProps = merged.filter(t => t.hasProps);
        const withoutProps = merged.filter(t => !t.hasProps);

        if (withProps.length > 0) {
            content += `## ✅ Merged with Props (${withProps.length})\n\n`;
            for (const t of withProps) {
                content += `- ✅ [#${t.id}](${TRAC_BASE_URL}/ticket/${t.id}) - ${t.title}\n`;
                content += `  - **Contribution**: ${getTypeLabel(t.contributionType)}\n`;
                if (t.propsChangeset) {
                    content += `  - **Changeset**: [${t.propsChangeset}](${TRAC_BASE_URL}/changeset/${t.propsChangeset})\n`;
                }
                content += `\n`;
            }
        }

        if (withoutProps.length > 0) {
            content += `## ❌ Merged without Props (${withoutProps.length})\n\n`;
            for (const t of withoutProps) {
                content += `- ❌ [#${t.id}](${TRAC_BASE_URL}/ticket/${t.id}) - ${t.title}\n`;
                content += `  - **Contribution**: ${getTypeLabel(t.contributionType)}\n\n`;
            }
        }
    }

    content += `---
**Total Merged**: ${merged.length} | ✅ With Props: ${merged.filter(t => t.hasProps).length}
`;

    return content;
}

// Generate 7.0-release/tickets.md
function generate7ReleaseTickets(tickets) {
    const releaseTickets = tickets.filter(t => t.milestone && t.milestone.includes('7.0'));

    let content = `# WordPress 7.0 Release Contributions

My contributions targeting the WordPress 7.0 release.

<!-- AUTO-SYNC - DO NOT EDIT -->

`;

    if (releaseTickets.length === 0) {
        content += `*No 7.0 milestone tickets yet*\n\n`;
    } else {
        // Group by component
        const byComponent = {};
        for (const t of releaseTickets) {
            const comp = t.component || 'General';
            if (!byComponent[comp]) byComponent[comp] = [];
            byComponent[comp].push(t);
        }

        for (const comp of Object.keys(byComponent).sort()) {
            content += `## ${comp}\n\n`;
            for (const t of byComponent[comp]) {
                const propsIcon = t.hasProps ? '✅' : (t.isMerged ? '❌' : '⏳');
                content += `### ${propsIcon} [#${t.id}](${TRAC_BASE_URL}/ticket/${t.id})\n`;
                content += `**${t.title}**\n\n`;
                content += `| Field | Value |\n`;
                content += `|-------|-------|\n`;
                content += `| Type | ${getTypeLabel(t.contributionType)} |\n`;
                content += `| Status | ${t.status} |\n`;
                if (t.focuses) content += `| Focuses | ${t.focuses} |\n`;
                if (t.keywords) content += `| Keywords | ${t.keywords} |\n`;
                content += `| Props | ${propsIcon} ${t.hasProps ? 'Received' : (t.isMerged ? 'Not Given' : 'Pending')} |\n`;
                content += `\n`;
            }
        }
    }

    const withProps = releaseTickets.filter(t => t.hasProps).length;
    const pending = releaseTickets.filter(t => !t.hasProps && !t.isMerged).length;
    const mergedNoProps = releaseTickets.filter(t => !t.hasProps && t.isMerged).length;

    content += `---
## Summary
| Status | Count |
|--------|------:|
| ✅ Props | ${withProps} |
| ⏳ Pending | ${pending} |
| ❌ Merged (No Props) | ${mergedNoProps} |
| **Total** | **${releaseTickets.length}** |
`;

    return content;
}

// Update README with stats
function updateReadme(tickets) {
    const total = tickets.length;
    const withProps = tickets.filter(t => t.hasProps).length;
    const merged = tickets.filter(t => t.isMerged).length;
    const testReports = tickets.filter(t => t.contributionType === 'test-report').length;
    const patches = tickets.filter(t => t.contributionType === 'patch').length;
    const pending = tickets.filter(t => !t.isMerged).length;
    const propsRate = total > 0 ? Math.round((withProps / merged) * 100) || 0 : 0;
    const release70 = tickets.filter(t => t.milestone && t.milestone.includes('7.0')).length;

    const content = `# WordPress Core Trac Contributions

Personal tracking for my WordPress Core Trac contributions.

## Quick Navigation

### 📊 Contributions
- 📝 [All Tickets](./contributed/tickets.md) - Every ticket I'm involved in
- 🧪 [Test Reports](./contributed/test-reports.md) - My testing contributions
- ✅ [Props Received](./contributed/with-props.md) - Credits received
- ⏳ [No Props Yet](./contributed/without-props.md) - Pending/missed props

### ✅ Merged
- 🎉 [Merged Tickets](./merged/tickets.md) - Merged into WordPress Core

### 🚀 7.0 Release
- 🎯 [7.0 Release](./7.0-release/tickets.md) - **${release70}** tickets for WP 7.0

### 🎯 Goals
- [2026 Goals](./next-targets/2026-goals.md) - Contribution targets
- 👤 [About Me](./about-me.md) - Profile & expertise

## 📈 Stats

<table width="100%">
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
| [🔒 Merged](./merged/tickets.md) | ${merged} |
| [⏳ Pending](./contributed/without-props.md) | ${pending} |

</td>
<td width="33.33%" valign="top">

| Type | Count |
|:-------|------:|
| [🧪 Test Reports](./contributed/test-reports.md) | ${testReports} |
| 📝 Patches | ${patches} |
| 💬 Comments | ${total - testReports - patches} |

</td>
<td width="33.34%" valign="top">

| Metric | Value |
|:-------|:------|
| 📈 Props Rate | **${propsRate}%** |
| 🎯 7.0 Tickets | **${release70}** |
| 🔥 Active | **${pending}** pending |
| ⭐ Success | **${withProps}** props |

</td>
</tr>
</table>
`;

    return content;
}

// Main sync function
async function main() {
    console.log('🚀 Starting WordPress Core Trac sync...\n');

    // Ensure directories exist
    [CONTRIBUTED_DIR, MERGED_DIR, RELEASE_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });

    // Process all tickets
    const tickets = await processAllTickets();

    if (tickets.length === 0) {
        console.log('\n❌ No tickets found. Exiting.');
        return;
    }

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

    fs.writeFileSync(
        path.join(RELEASE_DIR, 'tickets.md'),
        generate7ReleaseTickets(tickets)
    );
    console.log('   ✅ 7.0-release/tickets.md');

    fs.writeFileSync(README_FILE, updateReadme(tickets));
    console.log('   ✅ README.md');

    console.log('\n✅ Sync complete!');
    console.log(`   📊 Total: ${tickets.length} tickets`);
    console.log(`   ✅ Props: ${tickets.filter(t => t.hasProps).length}`);
    console.log(`   🔒 Merged: ${tickets.filter(t => t.isMerged).length}`);
    console.log(`   🧪 Test Reports: ${tickets.filter(t => t.contributionType === 'test-report').length}`);
}

main().catch(console.error);
