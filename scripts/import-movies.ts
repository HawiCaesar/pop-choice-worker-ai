import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import OpenAI from "openai";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

// Load environment variables from .env.local
dotenv.config({ path: path.join(__dirname, "..", ".env.local") });

const CONVEX_URL = process.env.CONVEX_URL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!CONVEX_URL) {
  console.error("❌ Missing CONVEX_URL environment variable");
  console.log("   Set it with: export CONVEX_URL=https://your-deployment.convex.cloud");
  process.exit(1);
}

if (!OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY environment variable");
  console.log("   Set it with: export OPENAI_API_KEY=sk-...");
  process.exit(1);
}

const convex = new ConvexHttpClient(CONVEX_URL);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

type Movie = {
  title: string;
  content: string;
};

const parseMoviesFile = (filePath: string): Movie[] => {
  const fileContent = fs.readFileSync(filePath, "utf-8");
  const lines = fileContent.split("\n");
  const movies: Movie[] = [];

  let currentTitle = "";
  let currentDescription = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip empty lines
    if (!line) {
      // If we have a title and description, save the movie
      if (currentTitle && currentDescription) {
        movies.push({
          title: currentTitle,
          content: `${currentTitle}\n${currentDescription}`,
        });
        currentTitle = "";
        currentDescription = "";
      }
      continue;
    }

    // Check if this is a title line (contains year pattern like "2023 |" or "2022 |")
    const isTitleLine = /^\w.*:\s*\d{4}\s*\|/.test(line);

    if (isTitleLine) {
      // Save previous movie if exists
      if (currentTitle && currentDescription) {
        movies.push({
          title: currentTitle,
          content: `${currentTitle}\n${currentDescription}`,
        });
      }
      currentTitle = line;
      currentDescription = "";
    } else {
      // This is a description line
      currentDescription += (currentDescription ? " " : "") + line;
    }
  }

  // Don't forget the last movie
  if (currentTitle && currentDescription) {
    movies.push({
      title: currentTitle,
      content: `${currentTitle}\n${currentDescription}`,
    });
  }

  return movies;
};

const generateEmbedding = async (text: string): Promise<number[]> => {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
    encoding_format: "float",
  });
  return response.data[0].embedding;
};

const importMovies = async () => {
  const moviesPath = path.join(__dirname, "..", "movies.txt");

  console.log("📂 Parsing movies.txt...");
  const movies = parseMoviesFile(moviesPath);
  console.log(`   Found ${movies.length} movies\n`);

  let successCount = 0;
  let errorCount = 0;

  for (let i = 0; i < movies.length; i++) {
    const movie = movies[i];
    const movieName = movie.title.split(":")[0];

    try {
      console.log(`[${i + 1}/${movies.length}] Processing: ${movieName}`);

      // Generate embedding
      console.log("   📊 Generating embedding...");
      const embedding = await generateEmbedding(movie.content);

      // Import to Convex
      console.log("   📤 Importing to Convex...");
      const movieId = await convex.mutation(api.movies.importMovie, {
        content: movie.content,
        embedding: embedding,
      });

      console.log(`   ✅ Imported! ID: ${movieId}\n`);
      successCount++;

      // Small delay to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 200));
    } catch (error: any) {
      console.error(`   ❌ Error: ${error.message}\n`);
      errorCount++;
    }
  }

  console.log("═".repeat(50));
  console.log(`✅ Successfully imported: ${successCount} movies`);
  if (errorCount > 0) {
    console.log(`❌ Failed: ${errorCount} movies`);
  }
  console.log("═".repeat(50));
};

// Run the import
importMovies().catch(console.error);
