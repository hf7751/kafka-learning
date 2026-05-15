#!/bin/bash

echo "=== Fixing format issues in 05-controller directory ==="
echo ""

# Function to add space between English and Chinese punctuation
fix_spacing() {
    local file="$1"
    echo "Processing $file..."
    
    # Backup original file
    cp "$file" "$file.bak"
    
    # Fix spacing issues
    sed -E '
        # Add space before Chinese punctuation after English
        s/\([a-zA-Z0-9])\([，。、；：])/\1 \2/g
        # Also handle cases without parentheses
        s/\([a-zA-Z0-9]\)\([，。、；：]\)/\1 \2/g
    ' "$file.bak" > "$file"
    
    echo "  Fixed spacing in $file"
}

# Files to fix
files=(
  "03-quorum-controller.md"
  "05-metadata-publishing.md"
  "18-migration-guide.md"
  "19-faq.md"
  "README.md"
  "01-krft-overview.md"
  "01-controller.md"
)

for file in "${files[@]}"; do
  if [ -f "$file" ]; then
    fix_spacing "$file"
  fi
done

echo ""
echo "=== Done!"
