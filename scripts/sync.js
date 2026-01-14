const fetch = require('node-fetch');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// Helper to write file only if changed
function writeFileIfChanged(filePath, content) {
    if (fs.existsSync(filePath)) {
        const oldContent = fs.readFileSync(filePath, 'utf8');
        // Ignore potential timestamp lines if needed, but for now strict equality is better than empty commits for EVERYTHING
        // If the content is identical, skip writing
        if (oldContent === content) {
            console.log(`   ⏭️  No changes for ${path.basename(filePath)}`);
            return;
        }
    }
    fs.writeFileSync(filePath, content);
    console.log(`   ✅ Updated ${path.basename(filePath)}`);
}

// Configuration
const USERNAME = process.env.TRAC_USERNAME || 'noruzzaman';
const TRAC_BASE_URL = 'https://core.trac.wordpress.org';

// IMPORTANT: This URL shows ONLY tickets where user actually participated
// NOT tickets where others mentioned the user's name
const MY_COMMENTS_URL = `${TRAC_BASE_URL}/my-comments/all?USER=${USERNAME}&max=200`;

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

// Fetch ONLY tickets where user actually participated (commented)
async function fetchMyParticipatedTickets() {
    console.log(`🔍 Fetching tickets where ${USERNAME} ACTUALLY participated...`);
    console.log(`   URL: ${MY_COMMENTS_URL}`);

    const allTickets = [];

    try {
        const response = await fetch(MY_COMMENTS_URL, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        if (!response.ok) throw new Error(`Trac query failed: ${response.status}`);

        const html = await response.text();
        const $ = cheerio.load(html);

        // Extract title to verify count
        const title = $('title').text();
        console.log(`   Page title: ${title}`);

        // Parse the ticket table - my-comments page uses class "listing"
        $('table.listing tr').each((i, row) => {
            if (i === 0) return; // Skip header row

            const $row = $(row);
            const ticketLink = $row.find('td.ticket a');
            const summaryLink = $row.find('td.summary a');
            const component = $row.find('td.component').text().trim();
            const milestone = $row.find('td.milestone').text().trim();
            const type = $row.find('td.type').text().trim();

            if (ticketLink.length) {
                const href = ticketLink.attr('href');
                const match = href.match(/\/ticket\/(\d+)/);

                if (match) {
                    const id = parseInt(match[1]);
                    allTickets.push({
                        id,
                        title: summaryLink.text().trim() || `Ticket #${id}`,
                        component: component || 'General',
                        status: 'open',
                        type: type || 'defect',
                        milestone: milestone || ''
                    });
                }
            }
        });

        console.log(`   ✅ Found ${allTickets.length} tickets where I participated`);
    } catch (error) {
        console.error('   ❌ Query failed:', error.message);
    }

    return allTickets;
}

// Fetch detailed ticket info
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

        // Find user's comments and determine contribution type
        let contributionType = 'comment';
        let commentCount = 0;
        let firstCommentDate = null;
        let allCommentText = '';

        // Check each change/comment section
        $('div.change').each((i, el) => {
            const $change = $(el);
            const changeHtml = $change.html() || '';

            // Check if this change was made by the user (check HTML for username)
            if (changeHtml.toLowerCase().includes(`>${USERNAME.toLowerCase()}<`) ||
                changeHtml.toLowerCase().includes(`"${USERNAME.toLowerCase()}"`) ||
                changeHtml.toLowerCase().includes(`/${USERNAME.toLowerCase()}`)) {

                commentCount++;
                // Get comment text from the comment div
                const commentEl = $change.find('.comment');
                const commentText = commentEl.text().trim();
                allCommentText += ' ' + commentText;
            }
        });

        // If no comments found via change divs, check full page for user's comments
        if (commentCount === 0) {
            // Fallback: search entire page HTML for structured test report
            const pageHtml = $.html().toLowerCase();
            if (pageHtml.includes(USERNAME.toLowerCase())) {
                // Check if user commented with test report format
                if (pageHtml.includes('test report') &&
                    pageHtml.includes('environment') &&
                    pageHtml.includes('actual results')) {
                    contributionType = 'test-report';
                    commentCount = 1;
                }
            }
        }

        // Determine contribution type from all comments
        const lowerText = allCommentText.toLowerCase();

        // Test Report detection - check for structured test report format
        if (lowerText.includes('test report') ||
            lowerText.includes('patch tested') ||
            lowerText.includes('actual results') ||
            lowerText.includes('environment') && lowerText.includes('wordpress:') ||
            lowerText.includes('tested') && lowerText.includes('result') ||
            lowerText.includes('i tested') ||
            lowerText.includes('can confirm') ||
            lowerText.includes('confirmed the') ||
            lowerText.includes('verified') ||
            lowerText.includes('works as expected')) {
            contributionType = 'test-report';
        } else if (lowerText.includes('attached') && lowerText.includes('patch') ||
            lowerText.includes('uploaded') ||
            lowerText.includes('.diff')) {
            contributionType = 'patch';
        } else if (lowerText.includes('lgtm') ||
            lowerText.includes('code looks good') ||
            lowerText.includes('reviewed')) {
            contributionType = 'code-review';
        }

        // Check if closed/merged
        const isClosed = status === 'closed';
        const isFixed = resolution.toLowerCase().includes('fixed');

        // Find changesets and check for props
        const changesets = [];
        $('a[href*="/changeset/"]').each((i, el) => {
            const href = $(el).attr('href');
            const match = href.match(/changeset\/(\d+)/);
            if (match && !changesets.includes(match[1])) {
                changesets.push(match[1]);
            }
        });

        // Check props in changesets
        let hasProps = false;
        let propsChangeset = null;

        for (const changesetId of changesets.slice(0, 5)) {
            try {
                const csUrl = `${TRAC_BASE_URL}/changeset/${changesetId}`;
                const csResponse = await fetch(csUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0' }
                });
                const csHtml = await csResponse.text();

                // Check if username appears in props
                if (csHtml.toLowerCase().includes(`props ${USERNAME.toLowerCase()}`) ||
                    csHtml.toLowerCase().includes(`props to ${USERNAME.toLowerCase()}`) ||
                    csHtml.toLowerCase().includes(`, ${USERNAME.toLowerCase()}`) ||
                    csHtml.toLowerCase().includes(`${USERNAME.toLowerCase()},`)) {
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
            commentCount,
            firstCommentDate,
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
    console.log('📥 Processing my participated tickets...\n');

    // Fetch ONLY tickets where I actually participated
    const ticketList = await fetchMyParticipatedTickets();

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
        await new Promise(resolve => setTimeout(resolve, 300));

        const details = await fetchTicketDetails(basic.id);

        if (details) {
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

    // Count stats
    const testReports = tickets.filter(t => t.contributionType === 'test-report').length;
    const patches = tickets.filter(t => t.contributionType === 'patch').length;
    const reviews = tickets.filter(t => t.contributionType === 'code-review').length;

    console.log(`\n✅ Processed ${tickets.length} tickets`);
    console.log(`   - With Props: ${tickets.filter(t => t.hasProps).length}`);
    console.log(`   - Merged: ${tickets.filter(t => t.isMerged).length}`);
    console.log(`   - Test Reports: ${testReports}`);
    console.log(`   - Patches: ${patches}`);
    console.log(`   - Code Reviews: ${reviews}`);

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

    let content = `# My Trac Contributions

Total **${tickets.length}** tickets where I participated.

> 📋 Source: [My Trac Comments](${MY_COMMENTS_URL})

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
            if (ticket.focuses) content += `| Focuses | ${ticket.focuses} |\n`;
            if (ticket.keywords) content += `| Keywords | ${ticket.keywords} |\n`;
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
        const withProps = testReports.filter(t => t.hasProps);
        const merged = testReports.filter(t => t.isMerged && !t.hasProps);
        const pending = testReports.filter(t => !t.isMerged);

        if (withProps.length > 0) {
            content += `## ✅ Props Received (${withProps.length})\n\n`;
            for (const t of withProps) {
                content += `- ✅ [#${t.id}](${TRAC_BASE_URL}/ticket/${t.id}) - ${t.title}\n`;
                content += `  - **Component**: ${t.component}`;
                if (t.milestone) content += ` | **Milestone**: ${t.milestone}`;
                content += `\n`;
                if (t.focuses) content += `  - **Focuses**: ${t.focuses}\n`;
                if (t.keywords) content += `  - **Keywords**: ${t.keywords}\n`;
                content += `\n`;
            }
        }

        if (merged.length > 0) {
            content += `## ❌ Merged Without Props (${merged.length})\n\n`;
            for (const t of merged) {
                content += `- ❌ [#${t.id}](${TRAC_BASE_URL}/ticket/${t.id}) - ${t.title}\n`;
                content += `  - **Component**: ${t.component}`;
                if (t.milestone) content += ` | **Milestone**: ${t.milestone}`;
                content += `\n`;
                if (t.focuses) content += `  - **Focuses**: ${t.focuses}\n`;
                if (t.keywords) content += `  - **Keywords**: ${t.keywords}\n`;
                content += `\n`;
            }
        }

        if (pending.length > 0) {
            content += `## ⏳ Pending (${pending.length})\n\n`;
            for (const t of pending) {
                content += `- ⏳ [#${t.id}](${TRAC_BASE_URL}/ticket/${t.id}) - ${t.title}\n`;
                content += `  - **Component**: ${t.component}`;
                if (t.milestone) content += ` | **Milestone**: ${t.milestone}`;
                content += ` | **Status**: ${t.status}\n`;
                if (t.focuses) content += `  - **Focuses**: ${t.focuses}\n`;
                if (t.keywords) content += `  - **Keywords**: ${t.keywords}\n`;
                content += `\n`;
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
            content += `  - **Component**: ${t.component}`;
            if (t.milestone) content += ` | **Milestone**: ${t.milestone}`;
            content += `\n`;
            if (t.focuses) content += `  - **Focuses**: ${t.focuses}\n`;
            if (t.keywords) content += `  - **Keywords**: ${t.keywords}\n`;
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
            content += `  - **Type**: ${typeLabel} | **Component**: ${t.component}`;
            if (t.milestone) content += ` | **Milestone**: ${t.milestone}`;
            content += ` | **Status**: ${t.status}\n`;
            if (t.focuses) content += `  - **Focuses**: ${t.focuses}\n`;
            if (t.keywords) content += `  - **Keywords**: ${t.keywords}\n`;
            content += `\n`;
        }
    }

    if (mergedNoProps.length > 0) {
        content += `## ❌ Merged Without Props (${mergedNoProps.length})\n\nThese were merged but I didn't get props.\n\n`;
        for (const t of mergedNoProps) {
            const typeLabel = getTypeLabel(t.contributionType);
            content += `- ❌ [#${t.id}](${TRAC_BASE_URL}/ticket/${t.id}) - ${t.title}\n`;
            content += `  - **Type**: ${typeLabel} | **Component**: ${t.component}`;
            if (t.milestone) content += ` | **Milestone**: ${t.milestone}`;
            content += `\n`;
            if (t.focuses) content += `  - **Focuses**: ${t.focuses}\n`;
            if (t.keywords) content += `  - **Keywords**: ${t.keywords}\n`;
            content += `\n`;
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
        const withProps = merged.filter(t => t.hasProps);
        const withoutProps = merged.filter(t => !t.hasProps);

        if (withProps.length > 0) {
            content += `## ✅ Merged with Props (${withProps.length})\n\n`;
            for (const t of withProps) {
                content += `- ✅ [#${t.id}](${TRAC_BASE_URL}/ticket/${t.id}) - ${t.title}\n`;
                content += `  - **Contribution**: ${getTypeLabel(t.contributionType)}\n`;
                content += `  - **Component**: ${t.component}`;
                if (t.milestone) content += ` | **Milestone**: ${t.milestone}`;
                content += `\n`;
                if (t.focuses) content += `  - **Focuses**: ${t.focuses}\n`;
                if (t.keywords) content += `  - **Keywords**: ${t.keywords}\n`;
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
                content += `  - **Contribution**: ${getTypeLabel(t.contributionType)}\n`;
                content += `  - **Component**: ${t.component}`;
                if (t.milestone) content += ` | **Milestone**: ${t.milestone}`;
                content += `\n`;
                if (t.focuses) content += `  - **Focuses**: ${t.focuses}\n`;
                if (t.keywords) content += `  - **Keywords**: ${t.keywords}\n`;
                content += `\n`;
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

// Generate stats.json for external consumption (e.g., Profile README)
function generateStatsJson(tickets) {
    const total = tickets.length;
    const withProps = tickets.filter(t => t.hasProps).length;
    const merged = tickets.filter(t => t.isMerged).length;
    const testReports = tickets.filter(t => t.contributionType === 'test-report').length;
    const release70 = tickets.filter(t => t.milestone && t.milestone.includes('7.0')).length;
    const pending = tickets.filter(t => !t.isMerged).length;

    // Count tickets by focus area
    const focusCounts = {};
    tickets.forEach(t => {
        if (t.focuses) {
            const focuses = t.focuses.split(',').map(f => f.trim().toLowerCase());
            focuses.forEach(f => {
                focusCounts[f] = (focusCounts[f] || 0) + 1;
            });
        }
    });

    const stats = {
        total,
        props: withProps,
        merged,
        test_reports: testReports,
        release_7_0: release70,
        pending,
        focus_areas: focusCounts
    };

    return JSON.stringify(stats, null, 2);
}

// Update README with stats
function updateReadme(tickets) {
    const total = tickets.length;
    const withProps = tickets.filter(t => t.hasProps).length;
    const merged = tickets.filter(t => t.isMerged).length;
    const testReports = tickets.filter(t => t.contributionType === 'test-report').length;
    const patches = tickets.filter(t => t.contributionType === 'patch').length;
    const pending = tickets.filter(t => !t.isMerged).length;
    const propsRate = merged > 0 ? Math.round((withProps / merged) * 100) : 0;
    const release70 = tickets.filter(t => t.milestone && t.milestone.includes('7.0')).length;

    const content = `# WordPress Core Trac Contributions

Personal tracking for my WordPress Core Trac contributions.

> 📋 Source: [My Trac Comments](${MY_COMMENTS_URL})

## Quick Navigation

<table width="100%">
<tr>
<td width="50%" valign="top">

### 📊 Contributions
- 📝 [All Tickets](./contributed/tickets.md) - Every ticket I contributed to
- 🧪 [Test Reports](./contributed/test-reports.md) - My testing contributions
- ✅ [Props Received](./contributed/with-props.md) - Credits received
- ⏳ [No Props Yet](./contributed/without-props.md) - Pending/missed props

</td>
<td width="50%" valign="top">

### 🎯 Milestone & Merged
- 🚀 [7.0 Release](./7.0-release/tickets.md) - **${release70}** tickets for WP 7.0
- 🎉 [Merged Tickets](./merged/tickets.md) - Merged into WordPress Core
- [2026 Goals](./next-targets/2026-goals.md) - Contribution targets
- 👤 [About Me](./about-me.md) - Profile & expertise

</td>
</tr>
</table>

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
    console.log(`👤 Username: ${USERNAME}`);
    console.log(`📋 Source: ${MY_COMMENTS_URL}\n`);

    // Ensure directories exist
    [CONTRIBUTED_DIR, MERGED_DIR, RELEASE_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });

    // Process tickets
    const tickets = await processAllTickets();

    if (tickets.length === 0) {
        console.log('\n❌ No tickets found. Exiting.');
        return;
    }

    console.log('\n📝 Generating markdown files...');

    // Generate and write all files
    writeFileIfChanged(
        path.join(CONTRIBUTED_DIR, 'tickets.md'),
        generateContributedTickets(tickets)
    );
    console.log('   ✅ contributed/tickets.md');

    writeFileIfChanged(
        path.join(CONTRIBUTED_DIR, 'test-reports.md'),
        generateTestReports(tickets)
    );
    console.log('   ✅ contributed/test-reports.md');

    writeFileIfChanged(
        path.join(CONTRIBUTED_DIR, 'with-props.md'),
        generateWithProps(tickets)
    );
    console.log('   ✅ contributed/with-props.md');

    writeFileIfChanged(
        path.join(CONTRIBUTED_DIR, 'without-props.md'),
        generateWithoutProps(tickets)
    );
    console.log('   ✅ contributed/without-props.md');

    writeFileIfChanged(
        path.join(MERGED_DIR, 'tickets.md'),
        generateMergedTickets(tickets)
    );
    console.log('   ✅ merged/tickets.md');

    writeFileIfChanged(
        path.join(RELEASE_DIR, 'tickets.md'),
        generate7ReleaseTickets(tickets)
    );
    console.log('   ✅ 7.0-release/tickets.md');

    writeFileIfChanged(
        path.join(__dirname, '..', 'README.md'),
        updateReadme(tickets)
    );
    console.log('   ✅ README.md');

    // Write stats.json
    writeFileIfChanged(
        path.join(__dirname, '..', 'stats.json'),
        generateStatsJson(tickets)
    );
    console.log('   ✅ stats.json (for Profile generation)');

    console.log('\n✅ Sync complete!');
    console.log(`   📊 Total: ${tickets.length} tickets`);
    console.log(`   ✅ Props: ${tickets.filter(t => t.hasProps).length}`);
    console.log(`   🔒 Merged: ${tickets.filter(t => t.isMerged).length}`);
    console.log(`   🧪 Test Reports: ${tickets.filter(t => t.contributionType === 'test-report').length}`);
}

main().catch(console.error);
