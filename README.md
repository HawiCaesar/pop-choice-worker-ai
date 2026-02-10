# Pop Choice Worker

A Cloudflare Worker that provides intelligent movie recommendations using vector similarity search and LLM-powered personalization.

## Overview

Pop Choice Worker is a serverless API that takes user preferences from multiple participants and recommends movies based on their collective interests. It uses semantic search to find relevant movies from a database and leverages GPT-4o-mini to explain why each recommendation matches the group's preferences.

## Technologies

### Core Infrastructure
- **[Cloudflare Workers](https://workers.cloudflare.com/)** - Serverless compute platform for edge deployment
- **[Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/)** - Proxy for OpenAI API calls with built-in cost tracking and output metrics

### AI & Embeddings
- **[OpenAI API](https://platform.openai.com/docs/api-reference)**
  - `text-embedding-3-small` (1536 dimensions) - Converts user preferences into vector embeddings
  - `gpt-4o-mini` - Generates personalized movie recommendation explanations

### Database & Vector Search
- **[Convex](https://www.convex.dev/)** - Real-time backend platform with built-in vector search capabilities
  - Stores movie content and pre-computed embeddings
  - Handles vector similarity search with configurable thresholds
  - Replaces previous Supabase implementation

### Observability & Monitoring
- **[Opik](https://www.comet.com/opik)** - LLM observability platform by Comet ML
  - Traces full request lifecycle with structured spans
  - Tracks token usage, costs, and latency
  - Monitors embedding generation, vector search, and LLM completion metrics

## Architecture Flow

```
User Input → Cloudflare Worker
  ↓
1. Generate Embedding (OpenAI text-embedding-3-small via AI Gateway)
  ↓
2. Vector Search (Convex vector index)
  ↓
3. LLM Recommendation (OpenAI gpt-4o-mini via AI Gateway)
  ↓
Response with personalized movie explanations
```

## Migration: Supabase → Convex

### Summary
Migrated from Supabase's PostgreSQL + pgvector to Convex's native vector search to simplify infrastructure and improve developer experience.

### Key Changes
- **Before**: Supabase RPC function `match_popchoice_unstructured` with PostgreSQL
- **After**: Convex action `searchMovies` with native vector index
- **Data Migration**: Imported ~50 movies from `movies.txt` with pre-computed embeddings
- **API Changes**:
  - Replaced `@supabase/supabase-js` client with `ConvexHttpClient`
  - Updated vector search call from RPC to Convex action

### Status
✅ **Complete** - All functionality migrated and tested in production

### Benefits
- Native vector search without managing PostgreSQL extensions
- Simplified schema definition with Convex's type-safe API
- Real-time capabilities for future features
- Reduced infrastructure complexity

See [migrate-to-convex.MD](./migrate-to-convex.MD) for detailed migration documentation.

## Observability & Metrics

The worker uses Opik to track detailed observability metrics across three main operations:

### 1. Embedding Generation Span
- Input text length and content
- Model used (`text-embedding-3-small`)
- Embedding dimensions (1536)
- Estimated token usage and cost

### 2. Vector Search Span
- Match threshold and count parameters
- Number of results returned
- Score metrics:
  - Top score (best match)
  - Average score (overall relevance)
  - Minimum score (threshold validation)

### 3. LLM Generation Span
- Model configuration (`gpt-4o-mini`, temperature: 1.1)
- Prompt length (system + user messages)
- Token usage breakdown:
  - Prompt tokens (input)
  - Completion tokens (output)
  - Total tokens
- Response length
- Cost calculation based on token pricing

### Metrics Tracked
All traces include:
- **Total cost** - Calculated from token usage across embedding + LLM calls
- **Total tokens** - Combined token usage
- **Success/failure status** - Error tracking with messages
- **Tags** - Number of participants, runtime preferences
- **Timing** - Automatic latency tracking per span

### Cost Calculation
Pricing (as of Feb 2024):
- `text-embedding-3-small`: $0.02 per 1M tokens
- `gpt-4o-mini`: $0.15 per 1M input tokens, $0.60 per 1M output tokens

## Testing

### Status
⚠️ **To Do** - End-to-end testing from the frontend application

### Planned Tests
- Integration tests covering the full recommendation flow
- Vector search accuracy validation
- Cost and performance benchmarks
- Error handling scenarios

## API

### `POST /`

Request:
```json
{
  "movieSetUpPreferences": {
    "numberOfPeople": "2",
    "time": "120 minutes"
  },
  "peopleResponses": [
    {
      "userResponses": "I like action movies",
      "stringifiedQueryAndResponses": "Q: Genre? A: Action movies"
    }
  ]
}
```

Response:
```json
{
  "movieRecommendations": [
    {
      "id": "...",
      "content": "Movie title, year, description...",
      "score": 0.85
    }
  ],
  "content": "Personalized explanation of recommendations",
  "noMatchFromLLM": false
}
```

## License

Private project
