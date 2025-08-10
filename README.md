# Art-factory Application Overview

This document explains what the Art-factory application does and how to run it.

## What the App Does

The Art-factory application is an automated system designed to generate and publish artwork based on geographical "catchments". It processes data through a multi-stage pipeline, leveraging a PostgreSQL database, a BullMQ job queue, and integrations with various external services like OpenAI (for content generation), Google (potentially for location data or imagery), Cloudinary (for image management), and Shopify (for e-commerce publishing).

**Core Functionality:**

1.  **Catchment Ingestion**: Defines a geographical area (a "catchment") via an HTTP POST request to the `/catchments` endpoint. This data (name, latitude, longitude, intro) is stored in a PostgreSQL database.
2.  **Automated Pipeline Triggering**: Upon insertion of new data into the `catchments`, `locations`, `photos`, or `artwork` tables, a PostgreSQL `pg_notify` event is triggered.
3.  **Watcher Service**: The `app/db/watchers.js` service listens for these database notifications. When an event occurs, it adds a corresponding job to a BullMQ queue (e.g., `qCatchment`, `qPhoto`, `qArtwork`, `qPublish`).
4.  **Asynchronous Processing Workflows**:
    *   **Catchment Processing (`app/workflows/catchment.js`)**: Processes the initial catchment job, likely identifying and inserting `locations` within that catchment.
    *   **Location to Photo Processing (`app/workflows/photos.js`)**: When a `location` is inserted, a `photo` job is enqueued. The `photo` worker then processes this, finding or generating images related to the location and storing them as `photos`.
    *   **Photo to Artwork Generation (`app/workflows/artwork.js`)**: When a `photo` is inserted, an `artwork` job is enqueued. The `artwork` worker transforms the photo into a piece of `artwork`, potentially using OpenAI for descriptions/styles and Framemock for mockups. Cloudinary is used for image hosting.
    *   **Artwork Publishing (`app/workflows/publish.js`)**: When `artwork` is inserted, a `publish` job is enqueued. The `publish` worker takes the generated artwork and publishes it to Shopify.
5.  **Manual Re-queueing**: An `/requeue/:stage/:id` endpoint allows for manual re-triggering of specific stages of the pipeline.

In essence, the application automates the entire process from defining a geographical area to generating unique artwork inspired by it and listing it for sale online.

## How to Run the App

1.  **Prerequisites**:
    *   Node.js (>=18.0.0)
    *   PostgreSQL database
    *   Redis instance
    *   Docker Desktop (recommended for local PostgreSQL/Redis setup)
    *   `.env` file configured with your API keys.

2.  **Docker Setup (for PostgreSQL and Redis)**:
    ```bash
    # Start PostgreSQL
    docker run --name art-factory-postgres -e POSTGRES_USER=artfactory -e POSTGRES_PASSWORD=artfactory -e POSTGRES_DB=artfactory -p 5433:5432 -v art-factory-pgdata:/var/lib/postgresql/data -d postgres:16

    # Start Redis
    docker run --name art-factory-redis -p 6379:6379 -d redis/redis-stack-server:latest
    ```

    **Troubleshooting PostgreSQL Docker Setup:**
    If you encounter issues with the `artfactory` user not existing or connection refused errors, it might indicate a problem with the Docker PostgreSQL container's initialization or persistence. In such cases, consider:
    *   Ensuring your Docker Desktop application is fully running and healthy.
    *   Stopping and removing the container and its associated volume for a clean restart:
        ```bash
        docker stop art-factory-postgres && docker rm art-factory-postgres && docker volume rm art-factory-pgdata
        ```
        Then re-run the `docker run` command for PostgreSQL.
    *   Alternatively, consider installing PostgreSQL directly on your operating system or using a cloud-hosted PostgreSQL database. If using a different setup, ensure the connection details in your `.env` file (`DATABASE_URL`) are correct and that the `artfactory` user and database are properly created.

3.  **Environment Variables (`.env` file content)**:
    Create a `.env` file in the root of the project with the following content, replacing the placeholder values with your actual API keys:
    ```
    # OpenAI
    OPENAI_API_KEY=...

    # Google Custom Search
    GOOGLE_API_KEY=...
    GOOGLE_CSE_ID=...

    # Cloudinary
    CLOUDINARY_CLOUD_NAME=...
    CLOUDINARY_API_KEY=...
    CLOUDINARY_API_SECRET=...

    # Frame mock-up service
    FRAME_MOCK_URL=...

    # Paint-API (PiAPI) — for generating the AI paintings
    PAINT_API_URL=...
    PAINT_API_KEY=...

    # Shopify
    SHOPIFY_SHOP=...

    # Database (Postgres)
    DATABASE_URL="postgresql://artfactory:artfactory@127.0.0.1:5433/artfactory"
    REDIS_URL="redis://localhost:6379"

    # Optional: custom port (defaults to 3000)
    PORT=3003
    ```

4.  **Install Dependencies**:
    ```bash
    pnpm install
    ```

5.  **Run Database Migrations**:
    ```bash
    npm run migrate
    ```

6.  **Start the Application**:
    ```bash
    npm run dev
    ```

7.  **Initiate First Task (Create Catchment)**:
    ```bash
    curl -X POST -H "Content-Type: application/json" -d '{
      "name": "Dublin City Centre",
      "lat": 53.3498,
      "lon": -6.2603,
      "intro": "A vibrant area in the heart of Dublin, known for its historical buildings and lively atmosphere."
    }' http://localhost:3003/catchments
