const fetch = require('node-fetch');
const cheerio = require('cheerio');

const URL = 'https://core.trac.wordpress.org/query?comment=~noruzzaman&col=id&col=summary&col=component&col=status&col=type&col=milestone&order=changetime&desc=1&max=100';

async function testFetch() {
    console.log(`Fetching ${URL}...`);
    try {
        const response = await fetch(URL, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        if (!response.ok) {
            console.error(`Failed: ${response.status} ${response.statusText}`);
            return;
        }
        const text = await response.text();
        console.log(`Length: ${text.length}`);

        const $ = cheerio.load(text);
        const tickets = [];

        // Trac usually puts tickets in a table class 'listing tickets' or similar
        // Looking at the user's screenshot, it looks like a standard query result table
        $('td.id a').each((i, el) => {
            const href = $(el).attr('href'); // /ticket/12345
            const id = href.split('/').pop().replace('#comment:', '');
            // remove comment anchors if any
            const cleanId = id.split('#')[0];
            if (cleanId && !tickets.includes(cleanId)) {
                tickets.push(cleanId);
            }
        });

        // Also try standard query selectors if 'my-comments' uses different structure
        if (tickets.length === 0) {
            $('.ticket a').each((i, el) => {
                const href = $(el).attr('href');
                if (href && href.includes('/ticket/')) {
                    const parts = href.split('/ticket/');
                    if (parts[1]) {
                        const cleanId = parts[1].split('#')[0];
                        if (cleanId && !isNaN(cleanId) && !tickets.includes(cleanId)) {
                            tickets.push(cleanId);
                        }
                    }
                }
            });
        }

        console.log(`Found ${tickets.length} unique tickets:`, tickets);

    } catch (error) {
        console.error('Error:', error);
    }
}

testFetch();
