/**
 * MemoryRetrievalQuery — the setup a retrieval runs against.
 *
 * The typed graph builder that used to live here walked skill evidence and
 * trade outcomes. Skills are documents now and retrieval matches their own
 * words, so the graph has no consumer; the query type is what remains.
 */

export interface MemoryRetrievalQuery {
    coin?: string;
    direction?: string;
    family?: string;
    pattern?: string;
    regime?: string;
}
