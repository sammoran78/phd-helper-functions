const SCAN_VERSION = 4;

const normalizeDoi = (value = '') => {
    const text = value.toString().trim().toLowerCase()
        .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '')
        .replace(/^doi:\s*/i, '');
    const match = text.match(/10\.\d{4,9}\/[\w.()/:;+-]+/i);
    return match ? match[0].replace(/[.,;:)\]}]+$/, '').toLowerCase() : '';
};

const normalizeTitle = (value = '') => value.toString().toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const titleTokens = (value = '') => normalizeTitle(value)
    .split(' ')
    .filter(token => token.length > 3 && ![
        'with', 'from', 'this', 'that', 'into', 'using', 'study', 'review',
        'beyond', 'between', 'through', 'towards', 'within', 'without'
    ].includes(token));

const sourceYear = (value) => {
    const match = (value ?? '').toString().match(/(?:18|19|20)\d{2}/);
    return match ? Number(match[0]) : null;
};

const firstAuthorSurname = (reference = {}) => {
    const raw = (reference.authors || reference.author || '').toString().trim();
    if (!raw) return '';
    const first = raw.split(/\s+&\s+|;|\band\b/i)[0].trim();
    if (first.includes(',')) return normalizeTitle(first.split(',')[0]);
    const parts = first.split(/\s+/).filter(Boolean);
    return normalizeTitle(parts[parts.length - 1] || '');
};

const authorSurnames = (reference = {}) => {
    const value = reference.authors || reference.author || '';
    const raw = (Array.isArray(value) ? value.join('; ') : value).toString().trim();
    if (!raw) return [];
    const surnames = new Set();
    for (const match of raw.matchAll(/([A-ZÀ-ÖØ-Þ][\p{L}'’\-]{2,}),\s*(?=[A-ZÀ-ÖØ-Þ])/gu)) {
        surnames.add(normalizeTitle(match[1]));
    }
    raw.split(/\s+&\s+|;|\band\b/iu).forEach(part => {
        const compact = part.trim();
        if (!compact || compact.includes(',')) return;
        const words = compact.match(/[\p{L}'’\-]+/gu) || [];
        const surname = normalizeTitle(words.at(-1) || '');
        if (surname.length >= 3) surnames.add(surname);
    });
    return [...surnames];
};

const candidateContainsCorpusAuthor = (candidate, reference) => {
    const extractedAuthors = normalizeTitle(candidate?.authors || '');
    if (!extractedAuthors) return false;
    const extractedTokens = new Set(extractedAuthors.split(' ').filter(Boolean));
    return authorSurnames(reference).some(surname => extractedTokens.has(surname));
};

const buildCorpusIndex = (references = []) => {
    const byDoi = new Map();
    const byTitle = new Map();
    const byAuthorYear = new Map();
    references.forEach(reference => {
        const doi = normalizeDoi(reference.doi || reference.url);
        const title = normalizeTitle(reference.title);
        const surname = firstAuthorSurname(reference);
        const year = sourceYear(reference.year);
        if (doi) byDoi.set(doi, reference);
        if (title.length >= 18) byTitle.set(title, reference);
        if (surname && year) {
            const key = `${surname}|${year}`;
            const matches = byAuthorYear.get(key) || [];
            matches.push(reference);
            byAuthorYear.set(key, matches);
        }
    });
    return { byDoi, byTitle, byAuthorYear, references };
};

const findReferenceStart = (pages = []) => {
    const sorted = [...pages].sort((a, b) => Number(a.pageNumber || a.pdfPageNumber || 0) - Number(b.pageNumber || b.pdfPageNumber || 0));
    const explicit = sorted.findIndex(page => /(?:^|\n)\s*(?:references|bibliography|works cited|literature cited)\s*(?:\n|$)/im.test(page.ocrText || ''));
    return explicit >= 0 ? explicit : Math.max(0, Math.floor(sorted.length * 0.72));
};

const isEntryStart = (line = '') => {
    const compact = line.toString().trim().replace(/^\[?\d{1,3}\]?\.?\s+/, '');
    if (!/^[A-ZÀ-ÖØ-Þ]/u.test(compact)) return false;
    const yearMatch = compact.match(/(?:18|19|20)\d{2}[a-z]?/i);
    if (!yearMatch || yearMatch.index > 180) return false;
    const prefix = compact.slice(0, yearMatch.index).trimEnd();
    if (/https?:\/\/|\bdoi\b/i.test(prefix)) return false;
    return /(?:\(|[.,])\s*$/.test(prefix);
};

const parseReferenceEntry = (text, pageNumber = null) => {
    const compact = (text || '').replace(/\s+/g, ' ').trim()
        .replace(/^\[?\d{1,3}\]?\.?\s+/, '')
        .replace(/\s+[-–—]{2,}\s*\d+\s*\/\s*\d+\s+https?:\/\/.*$/i, '')
        .replace(/\s+https?:\/\/doi\.org\/\S+\s+Published online by\b.*$/i, '');
    if (compact.length < 18) return null;
    const withoutUrls = compact.replace(/https?:\/\/\S+|\bdoi\s*:\s*\S+/gi, ' ');
    const distinctYears = new Set([...withoutUrls.matchAll(/(?:18|19|20)\d{2}/g)].map(match => match[0]));
    if (distinctYears.size > 1) return null;
    const yearMatch = compact.match(/(?:18|19|20)\d{2}[a-z]?/i);
    const doi = normalizeDoi(compact);
    if (!yearMatch && !doi) return null;

    const year = yearMatch ? Number(yearMatch[0].slice(0, 4)) : null;
    const beforeYear = yearMatch ? compact.slice(0, yearMatch.index).replace(/[\s,(]+$/, '') : '';
    const afterYear = yearMatch
        ? compact.slice((yearMatch.index || 0) + yearMatch[0].length).replace(/^[\s).,:;-]+/, '')
        : compact;
    const titleCandidate = afterYear.split(/\.\s+(?=[A-Z0-9])/)[0].trim();
    const title = titleCandidate.length >= 10 ? titleCandidate.slice(0, 320) : afterYear.slice(0, 320);
    const authorSurname = firstAuthorSurname({ authors: beforeYear });
    const canonicalKey = doi
        ? `doi:${doi}`
        : `${authorSurname || 'unknown'}|${year || 'nd'}|${normalizeTitle(title).slice(0, 140)}`;
    if (!doi && normalizeTitle(title).length < 12) return null;

    return {
        canonicalKey,
        doi: doi || null,
        year,
        authors: beforeYear.slice(0, 220) || null,
        authorSurname: authorSurname || null,
        title: title || null,
        displayCitation: compact.slice(0, 520),
        pageNumber,
        evidence: compact.slice(0, 700)
    };
};

const extractReferenceEntries = (pages = []) => {
    const sorted = [...pages].sort((a, b) => Number(a.pageNumber || a.pdfPageNumber || 0) - Number(b.pageNumber || b.pdfPageNumber || 0));
    const start = findReferenceStart(sorted);
    const entries = [];

    sorted.slice(start).forEach(page => {
        const pageNumber = Number(page.pageNumber || page.pdfPageNumber || 0) || null;
        const lines = (page.ocrText || '')
            .split(/\n+/)
            .map(line => line.replace(/\s+/g, ' ').trim())
            .filter(line => line && !/^(references|bibliography|works cited|literature cited)$/i.test(line));
        let current = '';
        const flush = () => {
            const parsed = parseReferenceEntry(current, pageNumber);
            if (parsed) entries.push(parsed);
            current = '';
        };
        lines.forEach(line => {
            if (isEntryStart(line) && current) flush();
            current = current ? `${current} ${line}` : line;
            if (current.length > 1400) flush();
        });
        if (current) flush();
    });

    return entries;
};

const titleTokenSimilarity = (left, right) => {
    const a = new Set(titleTokens(left));
    const b = new Set(titleTokens(right));
    let shared = 0;
    a.forEach(token => { if (b.has(token)) shared += 1; });
    const union = new Set([...a, ...b]).size;
    return {
        shared,
        leftCoverage: a.size ? shared / a.size : 0,
        rightCoverage: b.size ? shared / b.size : 0,
        minimumCoverage: a.size && b.size ? shared / Math.min(a.size, b.size) : 0,
        jaccard: union ? shared / union : 0
    };
};

const resolveCandidate = (candidate, index) => {
    if (candidate.doi && index.byDoi.has(candidate.doi)) {
        const reference = index.byDoi.get(candidate.doi);
        if (candidateContainsCorpusAuthor(candidate, reference)) {
            return { reference, matchType: 'doi', confidence: 1 };
        }
    }
    const normalizedCandidateTitle = normalizeTitle(candidate.title);
    if (normalizedCandidateTitle.length >= 18 && index.byTitle.has(normalizedCandidateTitle)) {
        const reference = index.byTitle.get(normalizedCandidateTitle);
        if (candidateContainsCorpusAuthor(candidate, reference)) {
            return { reference, matchType: 'title', confidence: 0.96 };
        }
    }
    if (normalizedCandidateTitle.length >= 24) {
        const fuzzy = index.references.find(reference => {
            const target = normalizeTitle(reference.title);
            const similarity = titleTokenSimilarity(target, normalizedCandidateTitle);
            return candidateContainsCorpusAuthor(candidate, reference)
                && target.length >= 24
                && (target.includes(normalizedCandidateTitle)
                    || normalizedCandidateTitle.includes(target)
                    || (similarity.shared >= 3 && similarity.minimumCoverage >= 0.82 && similarity.jaccard >= 0.55));
        });
        if (fuzzy) {
            return { reference: fuzzy, matchType: 'title_fuzzy', confidence: 0.88 };
        }
    }
    if (candidate.authorSurname && candidate.year) {
        const matches = index.byAuthorYear.get(`${candidate.authorSurname}|${candidate.year}`) || [];
        const similarity = matches.length === 1 ? titleTokenSimilarity(matches[0].title, candidate.title) : null;
        if (matches.length === 1
            && candidateContainsCorpusAuthor(candidate, matches[0])
            && similarity.shared >= 2
            && similarity.minimumCoverage >= 0.65
            && similarity.jaccard >= 0.45) {
            return { reference: matches[0], matchType: 'author_year_title', confidence: 0.78 };
        }
    }
    return null;
};

const findAmbiguousMatches = (candidate, index) => {
    const suggestions = new Map();
    const add = (reference, confidence, reason) => {
        if (!reference?.id || !candidateContainsCorpusAuthor(candidate, reference)) return;
        const previous = suggestions.get(reference.id);
        if (!previous || confidence > previous.confidence) {
            suggestions.set(reference.id, { reference, confidence: Number(confidence.toFixed(2)), reason });
        }
    };
    const normalizedCandidateTitle = normalizeTitle(candidate.title);
    if (normalizedCandidateTitle.length >= 18) {
        index.references.forEach(reference => {
            const similarity = titleTokenSimilarity(reference.title, normalizedCandidateTitle);
            if (similarity.shared >= 2
                && similarity.minimumCoverage >= 0.45
                && similarity.jaccard >= 0.25
                && similarity.minimumCoverage < 0.82) {
                add(reference, 0.58 + (similarity.jaccard * 0.28), 'partial_title_overlap');
            }
        });
    }
    if (candidate.authorSurname && candidate.year) {
        const matches = index.byAuthorYear.get(`${candidate.authorSurname}|${candidate.year}`) || [];
        matches.forEach(reference => {
            const similarity = titleTokenSimilarity(reference.title, candidate.title);
            const plausibleUnique = matches.length === 1 && similarity.shared >= 1 && similarity.minimumCoverage >= 0.25;
            const plausibleAmbiguous = matches.length > 1
                && similarity.shared >= 2
                && similarity.minimumCoverage >= 0.4
                && similarity.jaccard >= 0.25;
            if (plausibleUnique || plausibleAmbiguous) {
                add(reference, 0.6 + (similarity.jaccard * 0.22), matches.length === 1 ? 'author_year_title_partial' : 'ambiguous_author_year_title');
            }
        });
    }
    return [...suggestions.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 3);
};

const scanReferenceCitations = (sourceReference, pages, corpusReferences) => {
    const index = buildCorpusIndex(corpusReferences);
    const candidates = extractReferenceEntries(pages);
    const missingMap = new Map();
    const ambiguousMap = new Map();

    candidates.forEach(candidate => {
        const resolved = resolveCandidate(candidate, index);
        const suggestions = resolved
            ? [{ reference: resolved.reference, confidence: resolved.confidence, reason: resolved.matchType }]
            : findAmbiguousMatches(candidate, index);
        suggestions.forEach(suggestion => {
            if (suggestion.reference.id === sourceReference.id) return;
            const key = `${candidate.canonicalKey}->${suggestion.reference.id}`;
            ambiguousMap.set(key, {
                sourceReferenceId: sourceReference.id,
                targetReferenceId: suggestion.reference.id,
                candidateKey: candidate.canonicalKey,
                confidence: suggestion.confidence,
                reason: suggestion.reason,
                citation: candidate,
                evidence: [{
                    pageNumber: candidate.pageNumber,
                    excerpt: candidate.evidence,
                    section: 'bibliography'
                }]
            });
        });

        const existing = missingMap.get(candidate.canonicalKey);
        if (!existing) {
            missingMap.set(candidate.canonicalKey, {
                ...candidate,
                citedBySourceIds: [sourceReference.id],
                occurrenceCount: 1
            });
        } else {
            existing.occurrenceCount += 1;
        }
    });

    return {
        edges: [],
        ambiguousMatches: [...ambiguousMap.values()].slice(0, 300),
        missingWorks: [...missingMap.values()].slice(0, 400),
        candidateCount: candidates.length
    };
};

const aggregateCitationGraph = (references = [], scans = [], reviews = []) => {
    const index = buildCorpusIndex(references);
    const edgeMap = new Map();
    const missingMap = new Map();
    const referenceIds = new Set(references.map(reference => reference.id));
    const reviewKey = item => `${item.sourceReferenceId}|${item.candidateKey}|${item.targetReferenceId}`;
    const reviewsByKey = new Map(reviews.map(review => [reviewKey(review), review]));
    const ambiguousMap = new Map();
    const candidateStates = new Map();

    const addEdge = edge => {
        if (!referenceIds.has(edge.sourceReferenceId) || !referenceIds.has(edge.targetReferenceId) || edge.sourceReferenceId === edge.targetReferenceId) return;
        const key = `${edge.sourceReferenceId}->${edge.targetReferenceId}`;
        const previous = edgeMap.get(key);
        if (!previous || Number(edge.confidence || 0) > Number(previous.confidence || 0)) edgeMap.set(key, edge);
    };

    const applyProposedMatch = match => {
        if (!referenceIds.has(match.sourceReferenceId)
            || !referenceIds.has(match.targetReferenceId)
            || match.sourceReferenceId === match.targetReferenceId) return;
        const stateKey = `${match.sourceReferenceId}|${match.candidateKey}`;
        const state = candidateStates.get(stateKey) || { confirmed: false, pending: false, rejected: false };
        const review = reviewsByKey.get(reviewKey(match));
        if (review?.decision === 'confirmed') {
            state.confirmed = true;
            addEdge({
                sourceReferenceId: match.sourceReferenceId,
                targetReferenceId: match.targetReferenceId,
                matchType: 'human_verified',
                confidence: 1,
                evidence: match.evidence || [],
                reviewedAt: review.reviewedAt
            });
        } else if (review?.decision === 'rejected') {
            state.rejected = true;
        } else {
            state.pending = true;
            ambiguousMap.set(reviewKey(match), match);
        }
        candidateStates.set(stateKey, state);
    };

    scans.forEach(scan => {
        (scan.ambiguousMatches || []).forEach(applyProposedMatch);
        (scan.missingWorks || []).forEach(candidate => {
            const stateKey = `${scan.sourceReferenceId}|${candidate.canonicalKey}`;
            let state = candidateStates.get(stateKey);
            if (!state) {
                const resolved = resolveCandidate(candidate, index);
                if (resolved && resolved.reference.id !== scan.sourceReferenceId) {
                    applyProposedMatch({
                        sourceReferenceId: scan.sourceReferenceId,
                        targetReferenceId: resolved.reference.id,
                        candidateKey: candidate.canonicalKey,
                        confidence: resolved.confidence,
                        reason: `reconciled_${resolved.matchType}`,
                        citation: candidate,
                        evidence: candidate.evidence ? [{
                            pageNumber: candidate.pageNumber,
                            excerpt: candidate.evidence,
                            section: 'bibliography'
                        }] : []
                    });
                    state = candidateStates.get(stateKey);
                }
            }
            if (state?.confirmed || state?.pending) return;
            const key = candidate.canonicalKey;
            if (!key) return;
            const aggregate = missingMap.get(key) || {
                canonicalKey: key,
                doi: candidate.doi || null,
                year: candidate.year || null,
                authors: candidate.authors || null,
                title: candidate.title || null,
                displayCitation: candidate.displayCitation || null,
                citedBySourceIds: [],
                occurrenceCount: 0,
                evidence: []
            };
            if (!aggregate.citedBySourceIds.includes(scan.sourceReferenceId)) aggregate.citedBySourceIds.push(scan.sourceReferenceId);
            aggregate.occurrenceCount += Number(candidate.occurrenceCount || 1);
            if (candidate.evidence && aggregate.evidence.length < 3) {
                aggregate.evidence.push({
                    sourceReferenceId: scan.sourceReferenceId,
                    pageNumber: candidate.pageNumber,
                    excerpt: candidate.evidence
                });
            }
            missingMap.set(key, aggregate);
        });
    });

    const edges = [...edgeMap.values()];
    const degree = new Map(references.map(reference => [reference.id, { inbound: 0, outbound: 0 }]));
    edges.forEach(edge => {
        if (degree.has(edge.sourceReferenceId)) degree.get(edge.sourceReferenceId).outbound += 1;
        if (degree.has(edge.targetReferenceId)) degree.get(edge.targetReferenceId).inbound += 1;
    });
    const nodes = references.map(reference => ({
        id: reference.id,
        title: reference.title || 'Untitled',
        authors: reference.authors || reference.author || '',
        year: sourceYear(reference.year),
        doi: normalizeDoi(reference.doi || reference.url) || null,
        discipline: reference.discipline || reference.type || 'Unclassified',
        keywords: reference.keywords || reference.tags || '',
        connection: reference.connection || '',
        summary: reference.summary || '',
        ...degree.get(reference.id)
    }));

    return {
        nodes,
        edges,
        missingWorks: [...missingMap.values()]
            .sort((a, b) => b.citedBySourceIds.length - a.citedBySourceIds.length || b.occurrenceCount - a.occurrenceCount),
        ambiguousMatches: [...ambiguousMap.values()].sort((a, b) => b.confidence - a.confidence),
        scanVersion: SCAN_VERSION
    };
};

const resolveCitationReviewProposal = ({
    sourceReferenceId,
    targetReferenceId,
    candidateKey,
    graph,
    scans = [],
    reviews = [],
    submittedProposal = null
}) => {
    const isSameProposal = item => item
        && item.sourceReferenceId === sourceReferenceId
        && item.targetReferenceId === targetReferenceId
        && item.candidateKey === candidateKey;
    const pendingProposal = (graph?.ambiguousMatches || []).find(isSameProposal);
    const existingReview = reviews.find(isSameProposal);
    const scannedProposal = scans
        .flatMap(scan => scan?.ambiguousMatches || [])
        .find(isSameProposal);
    const submitted = submittedProposal && typeof submittedProposal === 'object'
        ? {
            ...submittedProposal,
            sourceReferenceId,
            targetReferenceId,
            candidateKey
        }
        : null;
    const proposal = pendingProposal || existingReview || scannedProposal || submitted || {
        sourceReferenceId,
        targetReferenceId,
        candidateKey
    };
    const proposalStateAtReview = pendingProposal
        ? 'pending'
        : (existingReview
            ? 'existing_review'
            : (scannedProposal ? 'scan_present' : (submitted ? 'stale_snapshot' : 'minimal_stale')));

    return { proposal, proposalStateAtReview, existingReview };
};

module.exports = {
    SCAN_VERSION,
    aggregateCitationGraph,
    buildCorpusIndex,
    extractReferenceEntries,
    findAmbiguousMatches,
    firstAuthorSurname,
    normalizeDoi,
    normalizeTitle,
    parseReferenceEntry,
    resolveCandidate,
    resolveCitationReviewProposal,
    scanReferenceCitations,
    sourceYear
};
