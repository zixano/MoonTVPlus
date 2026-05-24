'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { startTransition, useCallback, useEffect, useRef, useState } from 'react';

import BookCard from '@/components/books/BookCard';
import { buildBookDetailPath, cacheBookListItem } from '@/lib/book-route-cache.client';
import { BookListItem, BookSearchResult, BookSource } from '@/lib/book.types';

function detailHref(item: BookListItem) {
  return buildBookDetailPath(item.sourceId, item.id);
}

function SearchSkeleton() {
  return (
    <div className='grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-6 animate-pulse'>
      {Array.from({ length: 12 }).map((_, index) => (
        <div key={index} className='space-y-3'>
          <div className='aspect-[3/4] rounded-2xl bg-gray-200 dark:bg-gray-800' />
          <div className='h-4 w-3/4 rounded bg-gray-200 dark:bg-gray-800' />
          <div className='h-3 w-1/2 rounded bg-gray-200 dark:bg-gray-800' />
        </div>
      ))}
    </div>
  );
}

const BOOK_SEARCH_STATE_KEY = 'book_search_state';
const EMPTY_RESULT: BookSearchResult = { results: [], failedSources: [] };

export default function BooksSearchPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlQuery = searchParams.get('q') || '';
  const urlSourceId = searchParams.get('sourceId') || '';

  const [q, setQ] = useState(urlQuery);
  const [sourceId, setSourceId] = useState(urlSourceId);
  const [sources, setSources] = useState<BookSource[]>([]);
  const [result, setResult] = useState<BookSearchResult>(EMPTY_RESULT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [hasSearched, setHasSearched] = useState(false);
  const [totalSources, setTotalSources] = useState(0);
  const [completedSources, setCompletedSources] = useState(0);
  const [useFluidSearch, setUseFluidSearch] = useState(true);

  const restoredRef = useRef(false);
  const forceNextUrlSearchRef = useRef(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const currentSearchKeyRef = useRef('');
  const pendingResultsRef = useRef<BookListItem[]>([]);
  const flushTimerRef = useRef<number | null>(null);

  const getCacheKey = useCallback((keyword: string, selectedSourceId: string) => `book_search_cache_${selectedSourceId || 'all'}_${keyword.trim()}`, []);

  const getCachedResult = useCallback((keyword: string, selectedSourceId: string) => {
    if (typeof window === 'undefined' || !keyword.trim()) return null;
    try {
      const raw = sessionStorage.getItem(getCacheKey(keyword, selectedSourceId));
      return raw ? (JSON.parse(raw) as BookSearchResult) : null;
    } catch {
      return null;
    }
  }, [getCacheKey]);

  const setCachedResult = useCallback((keyword: string, selectedSourceId: string, nextResult: BookSearchResult) => {
    if (typeof window === 'undefined' || !keyword.trim()) return;
    try {
      sessionStorage.setItem(getCacheKey(keyword, selectedSourceId), JSON.stringify(nextResult));
    } catch {}
  }, [getCacheKey]);

  const readFluidSearchSetting = useCallback(() => {
    if (typeof window === 'undefined') return true;
    try {
      const savedFluidSearch = localStorage.getItem('fluidSearch');
      if (savedFluidSearch !== null) return JSON.parse(savedFluidSearch) !== false;
    } catch {}
    return (window as any).RUNTIME_CONFIG?.FLUID_SEARCH !== false;
  }, []);

  const closeEventSource = useCallback(() => {
    if (eventSourceRef.current) {
      try {
        eventSourceRef.current.close();
      } catch {}
      eventSourceRef.current = null;
    }
  }, []);

  const clearPendingResults = useCallback(() => {
    pendingResultsRef.current = [];
    if (flushTimerRef.current) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);

  const appendBufferedResults = useCallback((nextResults: BookListItem[]) => {
    if (nextResults.length === 0) return;
    pendingResultsRef.current.push(...nextResults);
    if (!flushTimerRef.current) {
      flushTimerRef.current = window.setTimeout(() => {
        const toAppend = pendingResultsRef.current;
        pendingResultsRef.current = [];
        startTransition(() => {
          setResult((prev) => ({ ...prev, results: prev.results.concat(toAppend) }));
        });
        flushTimerRef.current = null;
      }, 80);
    }
  }, []);

  const saveSearchState = useCallback((nextState: { q: string; sourceId: string; result: BookSearchResult }) => {
    if (typeof window === 'undefined') return;
    try {
      sessionStorage.setItem(BOOK_SEARCH_STATE_KEY, JSON.stringify(nextState));
    } catch {}
  }, []);

  const restoreSearchState = useCallback(() => {
    if (typeof window === 'undefined') return null;
    try {
      const raw = sessionStorage.getItem(BOOK_SEARCH_STATE_KEY);
      return raw ? (JSON.parse(raw) as { q: string; sourceId: string; result: BookSearchResult }) : null;
    } catch {
      return null;
    }
  }, []);

  const performSearch = useCallback(async (keyword: string, selectedSourceId: string, options?: { forceRefresh?: boolean }) => {
    const trimmed = keyword.trim();
    if (!trimmed) return;
    const normalizedSourceId = selectedSourceId || '';
    const searchKey = `${normalizedSourceId}::${trimmed}`;
    const forceRefresh = options?.forceRefresh === true;

    closeEventSource();
    clearPendingResults();
    currentSearchKeyRef.current = searchKey;
    setLoading(true);
    setError('');
    setHasSearched(true);
    setTotalSources(0);
    setCompletedSources(0);

    const cached = forceRefresh ? null : getCachedResult(trimmed, normalizedSourceId);
    if (cached) {
      setResult(cached);
      saveSearchState({ q: trimmed, sourceId: normalizedSourceId, result: cached });
      setLoading(false);
      setTotalSources(1);
      setCompletedSources(1);
      return;
    }

    setResult(EMPTY_RESULT);

    const currentFluidSearch = readFluidSearchSetting();
    setUseFluidSearch((prev) => (prev === currentFluidSearch ? prev : currentFluidSearch));

    const params = new URLSearchParams({ q: trimmed });
    if (normalizedSourceId) params.set('sourceId', normalizedSourceId);

    if (currentFluidSearch) {
      const es = new EventSource(`/api/books/search/ws?${params.toString()}`);
      eventSourceRef.current = es;

      es.onmessage = (event) => {
        if (!event.data || currentSearchKeyRef.current !== searchKey) return;
        try {
          const payload = JSON.parse(event.data);
          switch (payload.type) {
            case 'start':
              setTotalSources(payload.totalSources || 0);
              setCompletedSources(0);
              break;
            case 'source_result':
              setCompletedSources((prev) => Math.max(prev + 1, payload.completedSources || 0));
              if (Array.isArray(payload.results) && payload.results.length > 0) {
                appendBufferedResults(payload.results as BookListItem[]);
              }
              break;
            case 'source_error': {
              setCompletedSources((prev) => Math.max(prev + 1, payload.completedSources || 0));
              break;
            }
            case 'error':
              setError(payload.error || '搜索失败');
              setLoading(false);
              closeEventSource();
              break;
            case 'complete': {
              const finalFailedSources: BookSearchResult['failedSources'] = [];
              setCompletedSources(payload.completedSources || payload.totalSources || 0);
              if (pendingResultsRef.current.length > 0) {
                const toAppend = pendingResultsRef.current;
                pendingResultsRef.current = [];
                if (flushTimerRef.current) {
                  window.clearTimeout(flushTimerRef.current);
                  flushTimerRef.current = null;
                }
                startTransition(() => {
                  setResult((prev) => {
                    const nextResult = { results: prev.results.concat(toAppend), failedSources: finalFailedSources };
                    setCachedResult(trimmed, normalizedSourceId, nextResult);
                    saveSearchState({ q: trimmed, sourceId: normalizedSourceId, result: nextResult });
                    return nextResult;
                  });
                });
              } else {
                setResult((prev) => {
                  const nextResult = { results: prev.results, failedSources: finalFailedSources };
                  setCachedResult(trimmed, normalizedSourceId, nextResult);
                  saveSearchState({ q: trimmed, sourceId: normalizedSourceId, result: nextResult });
                  return nextResult;
                });
              }
              setLoading(false);
              closeEventSource();
              break;
            }
          }
        } catch {}
      };

      es.onerror = () => {
        if (currentSearchKeyRef.current !== searchKey) return;
        if (pendingResultsRef.current.length > 0) {
          const toAppend = pendingResultsRef.current;
          pendingResultsRef.current = [];
          if (flushTimerRef.current) {
            window.clearTimeout(flushTimerRef.current);
            flushTimerRef.current = null;
          }
          startTransition(() => {
            setResult((prev) => ({ ...prev, results: prev.results.concat(toAppend) }));
          });
        }
        setLoading(false);
        closeEventSource();
      };
      return;
    }

    try {
      const res = await fetch(`/api/books/search?${params.toString()}`);
      const json = await res.json();
      if (currentSearchKeyRef.current !== searchKey) return;
      if (!res.ok) throw new Error(json.error || '搜索失败');
      const nextResult: BookSearchResult = { results: json.results || [], failedSources: [] };
      setResult(nextResult);
      setTotalSources(1);
      setCompletedSources(1);
      setCachedResult(trimmed, normalizedSourceId, nextResult);
      saveSearchState({ q: trimmed, sourceId: normalizedSourceId, result: nextResult });
    } catch (err) {
      if (currentSearchKeyRef.current !== searchKey) return;
      setError((err as Error).message || '搜索失败');
      setResult(EMPTY_RESULT);
    } finally {
      if (currentSearchKeyRef.current === searchKey) {
        setLoading(false);
      }
    }
  }, [appendBufferedResults, clearPendingResults, closeEventSource, getCachedResult, readFluidSearchSetting, saveSearchState, setCachedResult]);

  useEffect(() => {
    setUseFluidSearch(readFluidSearchSetting());
    fetch('/api/books/sources').then((res) => res.json()).then((json) => setSources(json.sources || [])).catch(() => undefined);
    return () => {
      closeEventSource();
      clearPendingResults();
    };
  }, [clearPendingResults, closeEventSource, readFluidSearchSetting]);

  useEffect(() => {
    const keyword = urlQuery;
    const source = urlSourceId;

    if (!restoredRef.current) {
      restoredRef.current = true;
      if (!keyword) {
        const cachedState = restoreSearchState();
        if (cachedState?.q?.trim()) {
          setQ(cachedState.q);
          setSourceId(cachedState.sourceId || '');
          setResult(cachedState.result || EMPTY_RESULT);
          setHasSearched(true);
        }
        return;
      }
    }

    setQ(keyword);
    setSourceId(source);
    if (!keyword) {
      closeEventSource();
      clearPendingResults();
      setResult(EMPTY_RESULT);
      setLoading(false);
      setHasSearched(false);
      setTotalSources(0);
      setCompletedSources(0);
      setError('');
      return;
    }

    const forceRefresh = forceNextUrlSearchRef.current;
    forceNextUrlSearchRef.current = false;
    void performSearch(keyword, source, { forceRefresh });
  }, [clearPendingResults, closeEventSource, performSearch, restoreSearchState, urlQuery, urlSourceId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = q.trim();
    if (!trimmed) return;
    const params = new URLSearchParams();
    params.set('q', trimmed);
    if (sourceId) params.set('sourceId', sourceId);
    const nextUrl = `/books/search?${params.toString()}`;
    if (urlQuery === trimmed && urlSourceId === sourceId) {
      await performSearch(trimmed, sourceId, { forceRefresh: true });
    } else {
      forceNextUrlSearchRef.current = true;
      router.replace(nextUrl);
    }
  };

  return (
    <div className='space-y-6'>
      <section className='rounded-3xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-950'>
        <form onSubmit={handleSubmit} className='space-y-3'>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder='搜索书名 / 作者' className='w-full rounded-2xl border border-gray-200 px-4 py-3 outline-none dark:border-gray-700 dark:bg-gray-900' />
          <select value={sourceId} onChange={(e) => setSourceId(e.target.value)} className='w-full rounded-2xl border border-gray-200 px-4 py-3 dark:border-gray-700 dark:bg-gray-900'>
            <option value=''>全部书源</option>
            {sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
          </select>
          <button className='rounded-2xl bg-sky-600 px-4 py-2 text-sm text-white'>搜索</button>
        </form>
      </section>

      <div className='flex items-center justify-between gap-3'>
        <h2 className='text-lg font-semibold'>搜索结果{result.results.length > 0 ? `（${result.results.length}）` : ''}</h2>
        {loading && useFluidSearch && totalSources > 0 ? (
          <span className='text-xs text-gray-500 dark:text-gray-400'>搜索中 {completedSources}/{totalSources}</span>
        ) : null}
      </div>

      {loading && result.results.length === 0 ? <SearchSkeleton /> : null}
      {error ? <div className='rounded-2xl bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/20 dark:text-red-300'>{error}</div> : null}
      <section className='grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-6'>
        {result.results.map((item) => <BookCard key={`${item.sourceId}-${item.id}`} item={item} href={detailHref(item)} onNavigate={() => cacheBookListItem(item)} />)}
      </section>
      {!loading && hasSearched && !error && result.results.length === 0 ? <div className='text-sm text-gray-500'>暂无结果</div> : null}
    </div>
  );
}
