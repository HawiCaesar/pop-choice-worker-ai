import { action, internalQuery, mutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";

type MovieSearchResult = {
  id: Id<"movies">;
  content: string;
  score: number;
};

// Vector similarity search - replaces Supabase RPC 'match_popchoice_unstructured'
export const searchMovies = action({
  args: {
    embedding: v.array(v.float64()),
    matchThreshold: v.number(),
    matchCount: v.number(),
  },
  handler: async (ctx, args): Promise<MovieSearchResult[]> => {
    const results = await ctx.vectorSearch("movies", "by_embedding", {
      vector: args.embedding,
      limit: args.matchCount,
    });

    // Filter by threshold (Convex returns scores between 0 and 1)
    const filteredResults = results.filter(
      (result) => result._score >= args.matchThreshold
    );

    // Fetch full documents for each match
    const movies: MovieSearchResult[] = await Promise.all(
      filteredResults.map(async (result): Promise<MovieSearchResult> => {
        const doc: Doc<"movies"> | null = await ctx.runQuery(internal.movies.getMovie, {
          id: result._id,
        });
        return {
          id: result._id,
          content: doc?.content ?? "",
          score: result._score,
        };
      })
    );

    return movies;
  },
});

// Internal query to fetch movie by ID
export const getMovie = internalQuery({
  args: { id: v.id("movies") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

// Mutation to import a single movie (used for data migration)
export const importMovie = mutation({
  args: {
    content: v.string(),
    embedding: v.array(v.float64()),
  },
  handler: async (ctx, args) => {
    const movieId = await ctx.db.insert("movies", {
      content: args.content,
      embedding: args.embedding,
    });
    return movieId;
  },
});
