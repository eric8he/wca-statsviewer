const fs = require('fs-extra');
const { parse } = require('csv-parse');
const path = require('path');

const WCA_EXPORT_PATH = path.join(__dirname, '..', 'WCA_export');
const OUTPUT_PATH = path.join(__dirname, '..', 'data');

// Create data directory if it doesn't exist
fs.ensureDirSync(OUTPUT_PATH);

async function processResults() {
    const allAverages = []; // Store all valid averages
    
    return new Promise((resolve, reject) => {
        fs.createReadStream(path.join(WCA_EXPORT_PATH, 'WCA_export_Results.tsv'))
            .pipe(parse({
                delimiter: '\t',
                columns: true,
                skip_empty_lines: true
            }))
            .on('data', (row) => {
                // Only process 3x3 results with valid averages
                if (row.eventId === '333' && row.average > 0) {
                    allAverages.push({
                        personId: row.personId,
                        average: parseFloat(row.average) / 100, // Convert to seconds
                        competitionId: row.competitionId,
                        roundTypeId: row.roundTypeId,
                        pos: parseInt(row.pos),
                        date: row.competitionId.slice(0, 4) // Extract year from competition ID
                    });
                }
            })
            .on('end', async () => {
                // Sort all averages
                allAverages.sort((a, b) => a.average - b.average);

                // Save all averages to file
                await fs.writeJson(
                    path.join(OUTPUT_PATH, '3x3_all_averages.json'),
                    allAverages,
                    { spaces: 2 }
                );
                
                console.log(`Processed ${allAverages.length} averages`);
                console.log(`Top 3 averages of all time:`);
                allAverages.slice(0, 3).forEach((r, i) => {
                    console.log(`${i + 1}. ${r.personId}: ${r.average.toFixed(2)}s (${r.competitionId})`);
                });
                
                // Some interesting statistics
                const uniqueCompetitors = new Set(allAverages.map(r => r.personId)).size;
                const uniqueCompetitions = new Set(allAverages.map(r => r.competitionId)).size;
                console.log(`\nStatistics:`);
                console.log(`- Unique competitors: ${uniqueCompetitors}`);
                console.log(`- Unique competitions: ${uniqueCompetitions}`);
                console.log(`- Average solves per competitor: ${(allAverages.length / uniqueCompetitors).toFixed(2)}`);
                
                resolve();
            })
            .on('error', reject);
    });
}

// Run the processing
processResults()
    .then(() => console.log('Rankings generated successfully!'))
    .catch(err => {
        console.error('Error processing rankings:', err);
        process.exit(1);
    });
