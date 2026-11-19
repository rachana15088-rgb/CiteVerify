# CiteVerify – Scientific Claim and Citation Verification System

**An AI-powered platform for verifying scientific claims against their cited research sources.**

## 📌 Overview

CiteVerify is an AI-powered platform designed to strengthen academic integrity by checking whether scientific claims in research papers are genuinely supported by their cited references.

It extracts claims and citations from academic documents, retrieves original research publications, and compares the evidence to identify unsupported statements, misleading references and inaccurate citations.

## 🎯 Problem Statement

Academic documents often contain references that are incorrect, outdated, unrelated or insufficient to support the claims being made. Manually verifying every citation is time-consuming and can allow misleading information to go unnoticed.

CiteVerify aims to automate this verification process through AI and Natural Language Processing.

## 💡 Our Solution

CiteVerify provides an automated claim-verification workflow that:

- Extracts important scientific claims from uploaded documents.
- Identifies and maps citations to their corresponding references.
- Retrieves original research publications.
- Compares claims with evidence from cited sources.
- Classifies claims based on their level of support.
- Generates explainable verification reports with evidence and source links.

## ✨ Key Features

- **Document Upload:** Upload academic papers and research documents.
- **Claim Extraction:** Automatically identify statements requiring verification.
- **Citation Detection:** Extract and map references to relevant claims.
- **Source Retrieval:** Locate original research publications.
- **Evidence Comparison:** Compare claims with findings from cited papers.
- **Claim Classification:** Categorize findings as:
  - Supported
  - Partially Supported
  - Unsupported
  - Contradictory
  - Potentially Outdated
- **Explainable Results:** Display evidence passages and explanations.
- **Confidence Indicators:** Highlight uncertainty and evidence strength.
- **Verification Report:** Generate structured reports with source references.

## ⚙️ Technology Stack

| Component | Technology |
|---|---|
| Frontend | Streamlit |
| Backend | Python |
| PDF Processing | PyMuPDF |
| Natural Language Processing | spaCy |
| AI Analysis | LLM API |
| Research Retrieval | Crossref / OpenAlex |
| Data Processing | Pandas |

*The technology stack may be adapted during development.*

## 🔄 System Workflow

1. **Upload:** User uploads an academic document.
2. **Extract:** Extract scientific claims, citations and references.
3. **Retrieve:** Locate the original cited research publications.
4. **Compare:** Analyse the relationship between claims and source evidence.
5. **Classify:** Assign verification statuses with explanations.
6. **Report:** Generate an evidence-backed verification report.

## 🌍 Impact

CiteVerify aims to:

- Promote academic integrity and responsible research.
- Reduce misleading and unsupported citations.
- Save time spent on manual reference verification.
- Improve the reliability of academic documents.
- Help students and researchers make evidence-based decisions.

## 🔮 Future Scope

- Support for multiple academic document formats.
- Detection of retracted research publications.
- Advanced contradiction and outdated-reference detection.
- Batch verification of multiple research papers.
- Integration with academic writing platforms.

## 👥 Target Users

- Students
- Researchers
- Academic institutions
- Research scholars
- Journal reviewers

## ⚠️ Disclaimer

CiteVerify provides AI-assisted verification and confidence indicators. Its findings are intended to support human review and should not be treated as definitive academic judgments.

---

**Built for INNOVEDGE Hackathon 2026**

*Making academic research more transparent, reliable and trustworthy.*