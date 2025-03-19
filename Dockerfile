# Use Node.js as base image
FROM node:18

# Install PostgreSQL and other dependencies
RUN apt-get update && apt-get install -y \
    postgresql \
    postgresql-contrib \
    pgloader \
    default-mysql-server \
    default-mysql-client \
    sudo \
    && rm -rf /var/lib/apt/lists/*

# Configure sudo for node user
RUN echo "node ALL=(ALL) NOPASSWD: /usr/sbin/mysqld, /usr/bin/mysqladmin, /bin/chown, /usr/bin/tail" >> /etc/sudoers.d/node && \
    chmod 0440 /etc/sudoers.d/node

# Create directories with proper permissions
RUN mkdir -p /var/lib/postgresql/data /var/run/postgresql /usr/src/app/data \
    && chown -R postgres:postgres /var/lib/postgresql \
    && chown -R postgres:postgres /var/run/postgresql \
    && chmod 2777 /var/run/postgresql

# Initialize MySQL data directory and logs
RUN mkdir -p /var/lib/mysql /run/mysqld /var/log/mysql && \
    chown -R mysql:mysql /var/lib/mysql && \
    chown -R mysql:mysql /run/mysqld && \
    chown -R mysql:mysql /var/log/mysql && \
    chmod 777 /run/mysqld && \
    chmod 755 /var/log/mysql

# Initialize MariaDB as mysql user
USER mysql
RUN mysql_install_db --user=mysql --datadir=/var/lib/mysql --auth-root-authentication-method=normal
USER root

# Create MariaDB config
RUN echo '[mysqld]\n\
socket=/run/mysqld/mysqld.sock\n\
pid-file=/run/mysqld/mysqld.pid\n\
datadir=/var/lib/mysql\n\
log_error=/var/log/mysql/error.log\n\
user=mysql\n\
skip-grant-tables\n\
skip-networking=0\n\
bind-address=0.0.0.0' > /etc/mysql/conf.d/docker.cnf && \
    chmod 644 /etc/mysql/conf.d/docker.cnf

# Switch to postgres user to create the database
USER postgres

# Initialize PostgreSQL database
RUN /usr/lib/postgresql/*/bin/initdb -D /var/lib/postgresql/data

# Configure PostgreSQL
RUN echo "shared_buffers = '256MB'" >> /var/lib/postgresql/data/postgresql.conf && \
    echo "work_mem = '512MB'" >> /var/lib/postgresql/data/postgresql.conf && \
    echo "maintenance_work_mem = '1024MB'" >> /var/lib/postgresql/data/postgresql.conf

# Update PostgreSQL configuration to allow connections
RUN echo "host all all 0.0.0.0/0 md5" >> /var/lib/postgresql/data/pg_hba.conf && \
    echo "listen_addresses='*'" >> /var/lib/postgresql/data/postgresql.conf && \
    echo "unix_socket_directories='/var/run/postgresql'" >> /var/lib/postgresql/data/postgresql.conf

# Create the postgres user with password
RUN /usr/lib/postgresql/*/bin/pg_ctl -D /var/lib/postgresql/data start && \
    psql -c "ALTER USER postgres PASSWORD 'postgres';" && \
    /usr/lib/postgresql/*/bin/pg_ctl -D /var/lib/postgresql/data stop

# Switch back to root user
USER root

# Create directory for the application
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install app dependencies
RUN npm install

# Copy app source
COPY . .

# Ensure data directory has correct permissions
RUN chown -R node:node /usr/src/app/data

# Expose ports for Node.js and PostgreSQL
EXPOSE 3000 5432

# Create start script
RUN echo '#!/bin/bash\n\
# Start MySQL\n\
su mysql -c "mysqld_safe --skip-grant-tables" &\n\
sleep 5\n\
\n\
# Start PostgreSQL\n\
su postgres -c "/usr/lib/postgresql/*/bin/pg_ctl -D /var/lib/postgresql/data start"\n\
sleep 5\n\
\n\
# Run the setup script\n\
su node -c "npm run setup-db"\n\
\n\
# Start the application\n\
su node -c "npm start"' > /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Start both PostgreSQL and Node.js application
CMD ["/usr/local/bin/docker-entrypoint.sh"]
