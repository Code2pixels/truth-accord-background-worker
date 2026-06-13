const STOP_WORDS_LIST = [
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'his',
  'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'how', 'its', 'may', 'new',
  'now', 'old', 'see', 'way', 'who', 'did', 'has', 'her', 'him', 'his', 'say', 'she',
  'too', 'use', 'that', 'with', 'this', 'from', 'have', 'will', 'your', 'they', 'been',
  'more', 'when', 'would', 'there', 'their', 'what', 'about', 'which', 'could', 'should',
  'if', 'on', 'in', 'an', 'at', 'as', 'it', 'so', 'by', 'do', 'to', 'of', 'a', 'is', 'or',
  'be', 'no', 'up', 'down', 'over', 'under', 'into', 'out', 'before', 'after', 'off',
  'just', 'like', 'than', 'then', 'such', 'these', 'those', 'them', 'very', 'much',
  'any', 'each', 'other', 'some', 'also', 'were', 'because',
]

export const STOP_WORDS = new Set(STOP_WORDS_LIST)
