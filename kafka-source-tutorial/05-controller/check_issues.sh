#!/bin/bash

echo "=== Checking 05-controller directory for common issues ==="
echo ""

# Files to check (the 18 files from the list)
files=(
  "02-startup-flow.md"
  "03-quorum-controller.md"
  "04-raft-implementation.md"
  "05-metadata-publishing.md"
  "06-high-availability.md"
  "07-leader-election.md"
  "08-deployment-guide.md"
  "09-operations.md"
  "10-monitoring.md"
  "11-troubleshooting.md"
  "12-configuration.md"
  "13-performance-tuning.md"
  "14-debugging.md"
  "15-best-practices.md"
  "16-security.md"
  "17-backup-recovery.md"
  "18-migration-guide.md"
  "19-faq.md"
  "20-comparison.md"
)

total_issues=0

for file in "${files[@]}"; do
  if [ ! -f "$file" ]; then
    echo "✗ $file - NOT FOUND"
    continue
  fi
  
  file_issues=0
  
  # Check for "Option[" without space (should be "Option[")
  if grep -q "Option\[" "$file"; then
    echo "⚠ $file - contains 'Option[' (should be 'Option[')"
    ((file_issues++))
  fi
  
  # Check for term "服务器" (should use specific terms)
  if grep -q "服务器" "$file"; then
    echo "⚠ $file - contains '服务器' (consider using more specific term)"
    ((file_issues++))
  fi
  
  # Check for mixed ASCII hyphen instead of em dash in Chinese text
  if grep -E "[一-龥] - [一-龥]" "$file" > /dev/null; then
    echo "⚠ $file - contains ASCII hyphen in Chinese text (should use —)"
    ((file_issues++))
  fi
  
  # Check for missing spaces between English and Chinese
  if grep -E "[a-zA-Z][，。、；：]" "$file" > /dev/null; then
    echo "⚠ $file - missing space before Chinese punctuation"
    ((file_issues++))
  fi
  
  if [ $file_issues -gt 0 ]; then
    ((total_issues+=file_issues))
  fi
done

echo ""
echo "=== Summary ==="
echo "Total issues found: $total_issues"
echo "Files checked: ${#files[@]}"
