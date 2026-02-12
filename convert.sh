#!/bin/bash
if test -f mask.png; then
	rm mask.png
fi

if test -f mask.svg; then
	rsvg-convert mask.svg -o mask.png
fi

if test -f mask.png; then
	mv -f mask.png ../db/mask.png
fi
