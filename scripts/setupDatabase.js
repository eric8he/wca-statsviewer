const axios = require('axios');
const fs = require('fs-extra');
const { exec } = require('child_process');
const { Pool } = require('pg');
const path = require('path');
const util = require('util');
const unzipper = require('unzipper');
const execPromise = util.promisify(exec);

// Database configuration
const dbConfig = {
    user: 'postgres',
    host: 'localhost',
    database: 'wca_stats',
    password: 'postgres',  // You might want to use environment variables for this
    port: 5432,
};

// URLs and paths
const WCA_SQL_URL = 'https://www.worldcubeassociation.org/export/results/WCA_export.sql.zip';
const DOWNLOAD_PATH = path.join(__dirname, '..', 'data', 'WCA_export.sql.zip');
const SQL_FILE_PATH = path.join(__dirname, '..', 'data', 'WCA_export.sql');

async function downloadFile(url, outputPath) {
    console.log('Downloading WCA database...');
    const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'stream'
    });

    await fs.ensureDir(path.dirname(outputPath));
    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

async function extractZipFile(zipPath, outputPath) {
    console.log('Extracting SQL file...');
    return new Promise((resolve, reject) => {
        fs.createReadStream(zipPath)
            .pipe(unzipper.Parse())
            .on('entry', (entry) => {
                if (entry.path.endsWith('.sql')) {
                    entry.pipe(fs.createWriteStream(outputPath));
                } else {
                    entry.autodrain();
                }
            })
            .on('error', reject)
            .on('close', resolve);
    });
}

async function createDatabase() {
    try {
        // Connect to default postgres database first
        const pool = new Pool({
            ...dbConfig,
            database: 'postgres'  // Connect to default database first
        });

        // Check if database exists
        const dbExists = await pool.query(
            "SELECT 1 FROM pg_database WHERE datname = $1",
            [dbConfig.database]
        );

        if (dbExists.rows.length === 0) {
            console.log('Creating database...');
            await pool.query(`CREATE DATABASE ${dbConfig.database}`);
        }

        await pool.end();
    } catch (error) {
        console.error('Error creating database:', error);
        throw error;
    }
}

async function startMySql() {
    console.log('Starting MySQL...');
    try {
        // Try to stop MySQL if it's running
        try {
            await execPromise('sudo mysqladmin -u root shutdown');
            // Wait a bit for shutdown to complete
            await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
            // Ignore error if MySQL wasn't running
        }

        // Ensure correct permissions
        await execPromise('sudo chown -R mysql:mysql /var/lib/mysql /run/mysqld');
        
        // Start MySQL daemon in the background
        await execPromise('sudo -u mysql mysqld --datadir=/var/lib/mysql --pid-file=/run/mysqld/mysqld.pid --socket=/run/mysqld/mysqld.sock --skip-grant-tables --skip-networking=0 &');
        
        // Give MySQL a moment to start
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        console.log('MySQL started successfully');
    } catch (error) {
        console.error('Error starting MySQL:', error);
        throw error;
    }
}

async function waitForMySql() {
    console.log('Waiting for MySQL to be ready...');
    for (let i = 0; i < 30; i++) {
        try {
            // Check if MySQL is running
            const pidExists = await execPromise('test -f /run/mysqld/mysqld.pid').then(() => true).catch(() => false);
            if (!pidExists) {
                throw new Error('MySQL process not found');
            }
            
            // Try to connect
            await execPromise('mysql -u root -e "SELECT 1"');
            console.log('MySQL is ready!');
            return;
        } catch (error) {
            if (i === 0) {
                console.log('MySQL not ready, waiting...');
            } else if (i % 5 === 0) {
                console.log(`Still waiting for MySQL... (${i} seconds)`);
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    
    // If we get here, MySQL failed to start. Let's check the error log
    try {
        const errorLog = await execPromise('sudo tail -n 20 /var/log/mysql/error.log');
        console.error('MySQL error log:', errorLog);
    } catch (error) {
        console.error('Could not read MySQL error log');
    }
    
    throw new Error('Timeout waiting for MySQL to be ready');
}

async function importDatabase() {
    console.log('Converting and importing database...');
    try {
        // Create a pgloader command file for better control
        const pgloaderConfig = `
LOAD DATABASE
     FROM mysql://root@localhost/wca_stats
     INTO postgresql://${dbConfig.user}:${dbConfig.password}@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}

WITH include drop, create tables, create indexes, reset sequences,
     preserve index names

SET maintenance_work_mem to '1024MB',
    work_mem to '512MB',
    search_path to 'public'

BEFORE LOAD DO
     $$ DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; $$,
     $$ SET SESSION AUTHORIZATION 'postgres'; $$;
`;
        
        const pgloaderConfigPath = path.join(__dirname, '..', 'data', 'import.load');
        await fs.writeFile(pgloaderConfigPath, pgloaderConfig);
        
        // Start MySQL
        await startMySql();
        
        // Wait for MySQL to be ready
        await waitForMySql();
        
        // First, create a MySQL database and import the SQL file
        console.log('Setting up MySQL database...');
        await execPromise('mysql -u root -e "DROP DATABASE IF EXISTS wca_stats; CREATE DATABASE wca_stats;"');
        await execPromise(`mysql -u root wca_stats < "${SQL_FILE_PATH}"`);
        
        // Then use pgloader to convert from MySQL to PostgreSQL
        console.log('Converting MySQL to PostgreSQL...');
        await execPromise(`PGLOADER_HARD_WORK_MEMORY=512MB PGLOADER_SOFT_WORK_MEMORY=256MB pgloader --on-error-stop --debug ${pgloaderConfigPath}`);
        
        // Clean up MySQL database and config file
        console.log('Cleaning up...');
        await execPromise('mysql -u root -e "DROP DATABASE wca_stats;"');
        await fs.unlink(pgloaderConfigPath);
        
        // Stop MySQL
        try {
            await execPromise('sudo mysqladmin -u root shutdown');
        } catch (error) {
            console.warn('Error stopping MySQL:', error.message);
        }
        
        console.log('Database conversion and import completed successfully!');
    } catch (error) {
        console.error('Error converting and importing database:', error);
        throw error;
    }
}

async function cleanup() {
    console.log('Cleaning up temporary files...');
    try {
        await fs.remove(DOWNLOAD_PATH);
        await fs.remove(SQL_FILE_PATH);
    } catch (error) {
        console.warn('Warning: Error during cleanup:', error);
    }
}

async function main() {
    try {
        // Download the zip file
        await downloadFile(WCA_SQL_URL, DOWNLOAD_PATH);
        console.log('Download completed!');

        // Extract the SQL file
        await extractZipFile(DOWNLOAD_PATH, SQL_FILE_PATH);
        console.log('Extraction completed!');

        // Create database if it doesn't exist
        await createDatabase();
        console.log('Database created/verified!');

        // Import the SQL file
        await importDatabase();
        console.log('Setup completed successfully!');

        // Clean up temporary files
        await cleanup();
    } catch (error) {
        console.error('Setup failed:', error);
        await cleanup();
        process.exit(1);
    }
}

// Run the script
main();
